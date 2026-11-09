from __future__ import annotations

from io import BytesIO
from typing import Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps, ImageStat
from numba import njit

DISPLAY_SIZE = (1200, 1600)
DIFFUSION_KERNELS: dict[str, tuple[int, tuple[tuple[int, int, int], ...]]] = {
    "stucki": (
        42,
        (
            (1, 0, 8), (2, 0, 4),
            (-2, 1, 2), (-1, 1, 4), (0, 1, 8), (1, 1, 4), (2, 1, 2),
            (-2, 2, 1), (-1, 2, 2), (0, 2, 4), (1, 2, 2), (2, 2, 1),
        ),
    ),
    "burkes": (
        32,
        (
            (1, 0, 8), (2, 0, 4),
            (-2, 1, 2), (-1, 1, 4), (0, 1, 8), (1, 1, 4), (2, 1, 2),
        ),
    ),
    "sierra": (
        32,
        (
            (1, 0, 5), (2, 0, 3),
            (-2, 1, 2), (-1, 1, 4), (0, 1, 5), (1, 1, 4), (2, 1, 2),
            (-1, 2, 2), (0, 2, 3), (1, 2, 2),
        ),
    ),
}


def smart_center(image: Image.Image, target_size: tuple[int, int]) -> tuple[float, float]:
    source_ratio = image.width / image.height
    target_ratio = target_size[0] / target_size[1]
    if source_ratio == target_ratio:
        return (0.5, 0.5)

    scale = min(256 / image.width, 256 / image.height, 1)
    sample_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    edges = ImageOps.grayscale(image.resize(sample_size, Image.Resampling.BILINEAR)).filter(ImageFilter.FIND_EDGES)
    edge_pixels = edges.load()

    if source_ratio > target_ratio:
        crop_width = max(1, round(edges.height * target_ratio))
        column_energy = [sum(edge_pixels[x, y] for y in range(edges.height)) for x in range(edges.width)]
        start = min(range(max(1, edges.width - crop_width + 1)), key=lambda x: -sum(column_energy[x:x + crop_width]))
        focal = (start + crop_width / 2) / edges.width
        return (0.65 * focal + 0.35 * 0.5, 0.5)

    crop_height = max(1, round(edges.width / target_ratio))
    row_energy = [sum(edge_pixels[x, y] for x in range(edges.width)) for y in range(edges.height)]
    start = min(range(max(1, edges.height - crop_height + 1)), key=lambda y: -sum(row_energy[y:y + crop_height]))
    focal = (start + crop_height / 2) / edges.height
    return (0.5, 0.65 * focal + 0.35 * 0.5)


def fit_image(
    image_bytes: bytes,
    *,
    smart_crop: bool = False,
    smart_enhance: bool = False,
    target_size: tuple[int, int] = DISPLAY_SIZE,
) -> Image.Image:
    with Image.open(BytesIO(image_bytes)) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")

    if smart_enhance:
        image = ImageOps.autocontrast(image, cutoff=1)
        image = ImageEnhance.Color(image).enhance(1.08)
        image = ImageEnhance.Contrast(image).enhance(1.04)

    centering = smart_center(image, target_size) if smart_crop else (0.5, 0.45)
    return ImageOps.fit(image, target_size, method=Image.Resampling.LANCZOS, centering=centering)


def quantize_display(
    image: Image.Image,
    output_colors: Sequence[tuple[int, int, int]],
    perceived_colors: Sequence[tuple[int, int, int]],
    algorithm: str = "floyd-steinberg",
) -> Image.Image:
    palette_image = Image.new("P", (1, 1))
    palette_values = [value for color in perceived_colors for value in color]
    padding_color = perceived_colors[0]
    palette_image.putpalette(
        palette_values + [value for _ in range(256 - len(perceived_colors)) for value in padding_color]
    )

    if algorithm == "floyd-steinberg":
        quantized = image.quantize(palette=palette_image, dither=Image.Dither.FLOYDSTEINBERG)
    else:
        quantized = diffuse_quantize(image, perceived_colors, algorithm)

    output_palette = [value for color in output_colors for value in color]
    quantized.putpalette(output_palette + [0] * (768 - len(output_palette)))
    return quantized


def diffuse_quantize(
    image: Image.Image,
    colors: Sequence[tuple[int, int, int]],
    algorithm: str,
) -> Image.Image:
    if algorithm not in DIFFUSION_KERNELS:
        raise ValueError(f"Unsupported dithering algorithm: {algorithm}")

    divisor, kernel = DIFFUSION_KERNELS[algorithm]
    rgb_pixels = np.asarray(image.convert("RGB"), dtype=np.float32)
    palette = np.asarray(colors, dtype=np.float32)
    diffusion = np.asarray(kernel, dtype=np.int16)
    indices = _diffuse_pixels(rgb_pixels, palette, diffusion, divisor)
    return Image.fromarray(indices, mode="P")


@njit
def _diffuse_pixels(
    pixels: np.ndarray,
    colors: np.ndarray,
    kernel: np.ndarray,
    divisor: int,
) -> np.ndarray:
    height, width, _channels = pixels.shape
    result = np.empty((height, width), dtype=np.uint8)
    color_count = colors.shape[0]

    for y in range(height):
        for x in range(width):
            red, green, blue = pixels[y, x, 0], pixels[y, x, 1], pixels[y, x, 2]
            best_index = 0
            best_distance = np.inf
            for index in range(color_count):
                distance = (
                    (red - colors[index, 0]) ** 2
                    + (green - colors[index, 1]) ** 2
                    + (blue - colors[index, 2]) ** 2
                )
                if distance < best_distance:
                    best_distance = distance
                    best_index = index

            result[y, x] = best_index
            error_red = red - colors[best_index, 0]
            error_green = green - colors[best_index, 1]
            error_blue = blue - colors[best_index, 2]
            for item in range(kernel.shape[0]):
                neighbor_x = x + kernel[item, 0]
                neighbor_y = y + kernel[item, 1]
                if 0 <= neighbor_x < width and 0 <= neighbor_y < height:
                    weight = kernel[item, 2] / divisor
                    pixels[neighbor_y, neighbor_x, 0] = min(
                        255.0, max(0.0, pixels[neighbor_y, neighbor_x, 0] + error_red * weight)
                    )
                    pixels[neighbor_y, neighbor_x, 1] = min(
                        255.0, max(0.0, pixels[neighbor_y, neighbor_x, 1] + error_green * weight)
                    )
                    pixels[neighbor_y, neighbor_x, 2] = min(
                        255.0, max(0.0, pixels[neighbor_y, neighbor_x, 2] + error_blue * weight)
                    )

    return result


def smart_overlay(image: Image.Image, lines: Sequence[str], font_at_size) -> Image.Image:
    if not lines:
        return image

    width, height = image.size
    band_height = min(240, height // 4)
    candidates = (image.crop((0, 0, width, band_height)), image.crop((0, height - band_height, width, height)))
    scores = []
    for candidate in candidates:
        grayscale = ImageOps.grayscale(candidate)
        edges = grayscale.filter(ImageFilter.FIND_EDGES)
        scores.append(ImageStat.Stat(grayscale).stddev[0] + ImageStat.Stat(edges).mean[0])

    y = 0 if scores[0] <= scores[1] else height - band_height
    background_mean = ImageStat.Stat(ImageOps.grayscale(candidates[0 if y == 0 else 1])).mean[0]
    panel_color = (0, 0, 0) if background_mean >= 128 else (255, 255, 255)
    text_color = "white" if panel_color == (0, 0, 0) else "black"
    overlay = Image.new("RGBA", (width, band_height), (*panel_color, 210))
    draw = ImageDraw.Draw(overlay)
    first_font_size = min(62, max(32, width // 18))
    second_font_size = min(38, max(22, width // 30))
    first_font = font_at_size(first_font_size, bold=True)
    second_font = font_at_size(second_font_size)

    while first_font_size > 22 and draw.textlength(lines[0], font=first_font) > width - 128:
        first_font_size -= 2
        first_font = font_at_size(first_font_size, bold=True)
    if len(lines) > 1:
        while second_font_size > 18 and draw.textlength(lines[1], font=second_font) > width - 132:
            second_font_size -= 2
            second_font = font_at_size(second_font_size)

    first_line = lines[0]
    while len(first_line) > 1 and draw.textlength(first_line, font=first_font) > max(1, width - 128):
        first_line = first_line[:-2].rstrip() + "…"
    second_line = lines[1] if len(lines) > 1 else ""
    while len(second_line) > 1 and draw.textlength(second_line, font=second_font) > max(1, width - 132):
        second_line = second_line[:-2].rstrip() + "…"

    line_height = first_font_size + second_font_size + 30
    top = max(16, (band_height - line_height) // 2)

    draw.text((64, top), first_line, font=first_font, fill=text_color)
    if second_line:
        draw.text((66, top + first_font_size + 12), second_line, font=second_font, fill=text_color)

    base = image.convert("RGBA")
    base.alpha_composite(overlay, dest=(0, y))
    return base.convert("RGB")
