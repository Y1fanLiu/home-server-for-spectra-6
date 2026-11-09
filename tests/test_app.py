import asyncio
import base64
import gzip
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from PIL import Image
from starlette.background import BackgroundTasks

from app import (
    DISPLAY_SIZE,
    EPDGZ_COLOR_INDICES,
    EPDGZ_OUTPUT_PATH,
    OUTPUT_PATH,
    PALETTE,
    SPECTRA6_OUTPUT_COLORS,
    SPECTRA6_PERCEIVED_COLORS,
    app,
    encode_epdgz,
    font_at_size,
    generate_and_push,
    generate_ai_image,
    render_display,
    resize_generated_image,
    run_generate_and_push,
    weather_description,
)
from image_processing import fit_image, quantize_display, smart_overlay


class DisplayImageTests(unittest.TestCase):
    def test_render_uses_display_size_and_spectra_palette(self) -> None:
        source = Image.new("RGB", (100, 150))
        pixels = source.load()
        for y in range(source.height):
            for x in range(source.width):
                pixels[x, y] = (x * 255 // source.width, y * 255 // source.height, 100)
        buffer = io.BytesIO()
        source.save(buffer, format="PNG")

        render_display(buffer.getvalue())

        with Image.open(OUTPUT_PATH) as result:
            self.assertEqual(result.size, DISPLAY_SIZE)
            colors = {tuple(color) for _count, color in result.convert("RGB").getcolors(maxcolors=DISPLAY_SIZE[0] * DISPLAY_SIZE[1])}
        self.assertTrue(colors.issubset(set(PALETTE)))
        self.assertGreater(len(colors), 1)

    def test_render_writes_firmware_compatible_epdgz(self) -> None:
        source = Image.new("RGB", (2, 1))
        source.putdata([(0, 0, 0), (255, 255, 255)])
        buffer = io.BytesIO()
        source.save(buffer, format="PNG")

        render_display(buffer.getvalue())

        packed_pixels = gzip.decompress(EPDGZ_OUTPUT_PATH.read_bytes())
        self.assertEqual(len(packed_pixels), DISPLAY_SIZE[0] * DISPLAY_SIZE[1] // 2)
        decoded_codes = bytes(
            code
            for byte in packed_pixels
            for code in (byte >> 4, byte & 0x0F)
        )
        codes = set(decoded_codes)
        self.assertTrue(codes.issubset(set(EPDGZ_COLOR_INDICES)))
        with Image.open(OUTPUT_PATH) as result:
            self.assertEqual(decoded_codes, result.tobytes())

    def test_render_handles_black_pixels(self) -> None:
        source = Image.new("RGB", (100, 150), color=(0, 0, 0))
        buffer = io.BytesIO()
        source.save(buffer, format="PNG")

        render_display(buffer.getvalue())

        packed_pixels = gzip.decompress(EPDGZ_OUTPUT_PATH.read_bytes())
        self.assertEqual(set(packed_pixels), {0})

    def test_alternate_dither_algorithms_produce_firmware_compatible_pixels(self) -> None:
        source = Image.new("RGB", (36, 24))
        source.putdata(
            [
                (x * 255 // 36, y * 255 // 24, (x + y) * 255 // 60)
                for y in range(24)
                for x in range(36)
            ]
        )
        for algorithm in ("stucki", "burkes", "sierra"):
            with self.subTest(algorithm=algorithm):
                result = quantize_display(source, SPECTRA6_OUTPUT_COLORS, SPECTRA6_PERCEIVED_COLORS, algorithm)
                packed = gzip.decompress(encode_epdgz(result))
                self.assertEqual(len(packed), source.width * source.height // 2)
                self.assertTrue(set(result.tobytes()).issubset(set(EPDGZ_COLOR_INDICES)))

    def test_smart_image_processing_and_overlay_return_display_sized_rgb(self) -> None:
        source = Image.new("RGB", (240, 120), color=(100, 110, 120))
        for x in range(170, 220):
            for y in range(25, 95):
                source.putpixel((x, y), (250, 245, 220))
        buffer = io.BytesIO()
        source.save(buffer, format="PNG")

        fitted = fit_image(buffer.getvalue(), smart_crop=True, smart_enhance=True, target_size=(120, 160))
        overlaid = smart_overlay(fitted, ("Test image", "Saturday, 7 November"), font_at_size)

        self.assertEqual(overlaid.size, (120, 160))
        self.assertEqual(overlaid.mode, "RGB")

    def test_epdgz_packs_pixels_high_nibble_first_per_row(self) -> None:
        indexed_image = Image.new("P", (3, 2))
        indexed_image.putdata([0, 1, 2, 3, 5, 6])

        packed_pixels = gzip.decompress(encode_epdgz(indexed_image))

        self.assertEqual(packed_pixels, bytes((0x01, 0x20, 0x35, 0x60)))

    def test_epdgz_endpoint_serves_the_generated_file(self) -> None:
        source = Image.new("RGB", (2, 1), color=(128, 128, 128))
        buffer = io.BytesIO()
        source.save(buffer, format="PNG")
        render_display(buffer.getvalue())

        async def get_file() -> httpx.Response:
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                return await client.get("/display.epdgz")

        response = asyncio.run(get_file())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/gzip")
        self.assertEqual(response.content, EPDGZ_OUTPUT_PATH.read_bytes())

    def test_push_endpoint_sends_prepared_epdgz_to_photoframe(self) -> None:
        epdgz_data = b"\x1f\x8bprepared-epdgz"
        frame_response = httpx.Response(200, request=httpx.Request("POST", "http://photoframe.local/api/display-image"))
        frame_client = AsyncMock()
        frame_client.post.return_value = frame_response
        frame_context = MagicMock()
        frame_context.__aenter__ = AsyncMock(return_value=frame_client)
        frame_context.__aexit__ = AsyncMock(return_value=None)

        async def push_image(epdgz_path: Path) -> httpx.Response:
            epdgz_path.write_bytes(epdgz_data)
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                with patch("app.generate_display", new=AsyncMock(return_value={"updatedAt": "now"})):
                    with patch("app.EPDGZ_OUTPUT_PATH", epdgz_path):
                        with patch("app.httpx.AsyncClient", return_value=frame_context):
                            return await client.post("/api/push")

        with tempfile.TemporaryDirectory() as directory:
            response = asyncio.run(push_image(Path(directory) / "display.epdgz"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "success")
        self.assertEqual(frame_client.post.call_args.args[0], "http://photoframe.local/api/display-image")
        self.assertEqual(frame_client.post.call_args.kwargs["content"], epdgz_data)
        self.assertEqual(
            frame_client.post.call_args.kwargs["headers"]["Content-Type"],
            "application/octet-stream",
        )

    def test_settings_endpoint_persists_processing_and_overlay_options(self) -> None:
        async def update_settings(config_path: Path) -> tuple[httpx.Response, httpx.Response]:
            transport = httpx.ASGITransport(app=app)
            with patch("app.CONFIG_PATH", config_path):
                async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                    saved = await client.put(
                        "/api/settings",
                        json={
                            "processing": {"dither": "sierra", "smartEnhance": True, "smartCrop": True},
                            "overlay": {"mode": "smart"},
                        },
                    )
                    status = await client.get("/api/status")
                    return saved, status

        with tempfile.TemporaryDirectory() as directory:
            saved, status = asyncio.run(update_settings(Path(directory) / "config.json"))

        self.assertEqual(saved.status_code, 200)
        self.assertEqual(status.json()["processing"]["dither"], "sierra")
        self.assertTrue(status.json()["processing"]["smartEnhance"])
        self.assertEqual(status.json()["overlay"]["mode"], "smart")

    def test_openai_image_generation_decodes_provider_image(self) -> None:
        buffer = io.BytesIO()
        Image.new("RGB", (4, 3), color=(30, 70, 110)).save(buffer, format="PNG")
        image_bytes = buffer.getvalue()
        response = httpx.Response(
            200,
            json={"data": [{"b64_json": base64.b64encode(image_bytes).decode("ascii")}]},
            request=httpx.Request("POST", "https://api.openai.com/v1/images/generations"),
        )
        client = AsyncMock()
        client.post.return_value = response
        client_context = MagicMock()
        client_context.__aenter__ = AsyncMock(return_value=client)
        client_context.__aexit__ = AsyncMock(return_value=None)

        async def generate() -> tuple[bytes, str]:
            with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}):
                with patch("app.httpx.AsyncClient", return_value=client_context):
                    return await generate_ai_image("openai", "A tiny landscape")

        result, extension = asyncio.run(generate())

        with Image.open(io.BytesIO(result)) as generated:
            self.assertEqual(generated.size, (1600, 1200))
        self.assertEqual(extension, ".png")
        self.assertEqual(
            client.post.call_args.args[0],
            "https://api.openai.com/v1/images/generations",
        )
        self.assertEqual(client.post.call_args.kwargs["headers"]["Authorization"], "Bearer test-key")
        self.assertEqual(client.post.call_args.kwargs["json"]["size"], "1536x1024")

    def test_gemini_image_generation_uses_official_sdk_and_resizes_portrait(self) -> None:
        buffer = io.BytesIO()
        Image.new("RGB", (4, 3), color=(30, 70, 110)).save(buffer, format="PNG")
        image_bytes = buffer.getvalue()
        response = SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    content=SimpleNamespace(
                        parts=[SimpleNamespace(inline_data=SimpleNamespace(data=image_bytes))]
                    )
                )
            ]
        )
        client = MagicMock()
        client.models.generate_content.return_value = response

        async def generate() -> tuple[bytes, str]:
            with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}):
                with patch("app.genai.Client", return_value=client):
                    with patch("app.GEMINI_IMAGE_MODEL", "gemini-nano-banana-2.1"):
                        return await generate_ai_image("google", "A tiny landscape", "portrait")

        result, extension = asyncio.run(generate())

        with Image.open(io.BytesIO(result)) as generated:
            self.assertEqual(generated.size, (1200, 1600))
        self.assertEqual(extension, ".png")
        client.models.generate_content.assert_called_once()
        self.assertEqual(client.models.generate_content.call_args.kwargs["model"], "gemini-nano-banana-2.1")
        self.assertEqual(client.models.generate_content.call_args.kwargs["contents"], "A tiny landscape")
        config = client.models.generate_content.call_args.kwargs["config"]
        self.assertEqual(config.response_modalities, ["IMAGE"])
        self.assertEqual(config.image_config.aspect_ratio, "3:4")
        self.assertEqual(config.image_config.image_size, "2K")
        self.assertIn("E Ink Spectra 6", config.system_instruction)
        self.assertIn("favor a bright overall exposure", config.system_instruction)
        self.assertIn("magenta", config.system_instruction)
        self.assertIn("do not force the image into a fixed", config.system_instruction)
        self.assertIn("Realistic photography and any", config.system_instruction)

    def test_gemini_landscape_uses_four_by_three_and_exact_resolution(self) -> None:
        image_bytes = Image.new("RGB", (4, 3), color=(30, 70, 110))
        buffer = io.BytesIO()
        image_bytes.save(buffer, format="PNG")
        response = SimpleNamespace(
            candidates=[
                SimpleNamespace(
                    content=SimpleNamespace(
                        parts=[SimpleNamespace(inline_data=SimpleNamespace(data=buffer.getvalue()))]
                    )
                )
            ]
        )
        client = MagicMock()
        client.models.generate_content.return_value = response

        async def generate() -> tuple[bytes, str]:
            with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}):
                with patch("app.genai.Client", return_value=client):
                    return await generate_ai_image("google", "A tiny landscape")

        result, _extension = asyncio.run(generate())

        self.assertEqual(
            client.models.generate_content.call_args.kwargs["config"].image_config.aspect_ratio,
            "4:3",
        )
        with Image.open(io.BytesIO(result)) as generated:
            self.assertEqual(generated.size, (1600, 1200))

    def test_ai_endpoint_saves_generated_image_for_normal_processing(self) -> None:
        buffer = io.BytesIO()
        Image.new("RGB", (4, 3), color=(100, 120, 140)).save(buffer, format="PNG")

        async def generate_source(uploads_path: Path) -> httpx.Response:
            transport = httpx.ASGITransport(app=app)
            with patch("app.UPLOADS_DIR", uploads_path):
                with patch("app.generate_ai_image", new=AsyncMock(return_value=(buffer.getvalue(), ".png"))):
                    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                        return await client.post(
                            "/api/ai/generate",
                            json={"provider": "openai", "prompt": "A calm sea at dawn", "orientation": "portrait"},
                        )

        with tempfile.TemporaryDirectory() as directory:
            uploads_path = Path(directory)
            response = asyncio.run(generate_source(uploads_path))

            self.assertEqual(response.status_code, 201)
            self.assertTrue((uploads_path / response.json()["filename"]).is_file())
            self.assertEqual(response.json()["type"], "upload")

    def test_generate_and_push_searches_movie_then_renders_and_pushes(self) -> None:
        source = {
            "id": "tmdb-1",
            "title": "Dune",
            "image": "https://image.tmdb.org/t/p/w780/dune.jpg",
            "type": "remote",
        }
        order: list[str] = []
        saved_configs: list[dict[str, object]] = []

        async def search(category: str, query: str) -> dict[str, object]:
            order.append("search")
            self.assertEqual(category, "movies")
            self.assertEqual(query, "Dune")
            return {"items": [source]}

        async def render() -> dict[str, str]:
            order.append("render")
            return {"updatedAt": "now"}

        async def push() -> int:
            order.append("push")
            return 200

        def save_config(config: dict[str, object]) -> None:
            order.append("save")
            saved_configs.append(config)

        with patch("app.read_config", return_value={"processing": {}, "overlay": {}}):
            with patch("app.write_config", side_effect=save_config):
                with patch("app.get_sources", new=AsyncMock(side_effect=search)):
                    with patch("app.generate_display", new=AsyncMock(side_effect=render)):
                        with patch("app.push_prepared_image", new=AsyncMock(side_effect=push)):
                            asyncio.run(
                                run_generate_and_push(
                                    {"text": "Make a movie poster for Dune"},
                                    "request-123",
                                )
                            )

        self.assertEqual(order, ["search", "save", "render", "push"])
        self.assertEqual(saved_configs[0]["source"], source)

    def test_generate_and_push_method_not_allowed_echoes_original_payload(self) -> None:
        payload = {"text": "Make a movie poster for Dune", "debug": "request-123"}

        async def request() -> httpx.Response:
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                return await client.request("GET", "/api/generate-and-push", json=payload)

        response = asyncio.run(request())

        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.json()["payload"], payload)
        self.assertIn("POST", response.headers["allow"])

    def test_generate_and_push_creates_ai_image_then_renders_and_pushes(self) -> None:
        image_buffer = io.BytesIO()
        Image.new("RGB", (4, 3), color=(100, 120, 140)).save(image_buffer, format="PNG")
        order: list[str] = []
        saved_configs: list[dict[str, object]] = []

        async def render() -> dict[str, str]:
            order.append("render")
            return {"updatedAt": "now"}

        async def push() -> int:
            order.append("push")
            return 200

        def save_config(config: dict[str, object]) -> None:
            order.append("save")
            saved_configs.append(config)

        with tempfile.TemporaryDirectory() as directory:
            uploads_path = Path(directory)
            with patch("app.UPLOADS_DIR", uploads_path):
                with patch("app.read_config", return_value={"processing": {}, "overlay": {}}):
                    with patch("app.write_config", side_effect=save_config):
                        with patch("app.available_ai_providers", return_value={"openai": False, "google": True}):
                            with patch(
                                "app.generate_ai_image",
                                new=AsyncMock(return_value=(image_buffer.getvalue(), ".png")),
                            ) as generate_image:
                                with patch("app.generate_display", new=AsyncMock(side_effect=render)):
                                    with patch("app.push_prepared_image", new=AsyncMock(side_effect=push)):
                                        asyncio.run(
                                            run_generate_and_push(
                                                {"text": "A bright red sailboat on a calm lake"},
                                                "request-456",
                                            )
                                        )

            self.assertTrue(list(uploads_path.iterdir()))
            self.assertEqual(saved_configs[0]["source"]["type"], "upload")
            generate_image.assert_awaited_once_with(
                "google",
                "A bright red sailboat on a calm lake",
                "portrait",
            )
            self.assertEqual(order, ["save", "render", "push"])

    def test_generate_and_push_returns_accepted_before_background_task_runs(self) -> None:
        payload = {"text": "A bright red sailboat on a calm lake", "provider": "google"}
        background_tasks = BackgroundTasks()
        with patch("app.available_ai_providers", return_value={"openai": False, "google": True}):
            response = asyncio.run(generate_and_push(payload, background_tasks))

        self.assertEqual(response.status_code, 202)
        response_body = json.loads(response.body)
        self.assertEqual(response_body["status"], "accepted")
        self.assertEqual(response_body["payload"], payload)
        self.assertTrue(response_body["requestId"])
        self.assertEqual(len(background_tasks.tasks), 1)
        self.assertEqual(background_tasks.tasks[0].func, run_generate_and_push)
        self.assertEqual(background_tasks.tasks[0].args[0], payload)

    def test_generated_image_resize_rejects_unknown_orientation(self) -> None:
            buffer = io.BytesIO()
            Image.new("RGB", (4, 3)).save(buffer, format="PNG")
            with self.assertRaises(ValueError):
                resize_generated_image(buffer.getvalue(), "square")

    def test_weather_codes_have_human_readable_descriptions(self) -> None:
        self.assertEqual(weather_description(0), "Clear sky")
        self.assertEqual(weather_description(61), "Rain")
        self.assertEqual(weather_description(71), "Snow")


if __name__ == "__main__":
    unittest.main()
