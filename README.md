# Frame / Spectra 6

A small Mac-hosted image server for a portrait 1200 × 1600 e-ink display. The configuration page lets you upload an image from a phone, browse movie and TV posters, nature photography, and museum collection images, or select Copenhagen weather. Fixed `/display.png` and `/display.epdgz` URLs serve the latest prepared image as a PNG preview and a display-ready EPDGZ file.

## Start on macOS

1. Install Python 3.10 or newer.
2. Create a virtual environment: `python3 -m venv .venv`.
3. Install dependencies: `.venv/bin/pip install -r requirements.txt`.
4. Copy `.env.example` to `.env`. To enable movie posters, add a TMDB API key to `TMDB_API_KEY`. Movie search uses TMDB's API and poster images; follow [TMDB's terms](https://www.themoviedb.org/terms-of-use).
5. Run `.venv/bin/uvicorn app:app --host 0.0.0.0 --port 3000` and open `http://localhost:3000`.

The server binds to all network interfaces and advertises `homeserver.local` over Bonjour, so a phone on the same Wi-Fi can open `http://homeserver.local:3000`. The fixed preview and device URLs are `http://homeserver.local:3000/display.png` and `http://homeserver.local:3000/display.epdgz`. macOS may ask whether Python can accept local network connections; allow it. Do not expose this unauthenticated service directly to the public internet or forward its port from your router.

## Display image

The stable preview URL is `http://homeserver.local:3000/display.png`; it returns PNG at 1200 × 1600. The display-ready file is served at `http://homeserver.local:3000/display.epdgz`. Both crop to portrait and use the esp32-photoframe Spectra 6 palette with its default Floyd–Steinberg dithering. EPDGZ contains gzip-compressed, row-major 4-bit pixels in the firmware's color-index format. The configured source is rendered when the server starts, on demand via **Prepare image now**, and at midnight in `Europe/Copenhagen`. Keep the Mac awake and the server running for the scheduled refresh.

Select an image and choose **Send to PhotoFrame** to prepare it in EPDGZ format and send it directly to `http://photoframe.local/api/display-image`. If the frame uses HTTP Basic authentication, set `PHOTOFRAME_PASSWORD` in `.env`. Set `PHOTOFRAME_URL` in `.env` to override the frame base URL.

Uploaded images and configuration are stored under `data/` on the Mac. Image sources use The Met's public collection API, Wikimedia Commons, TMDB (optional key), and Open-Meteo (weather, no key required). The weather image includes Copenhagen's current temperature, condition, and date.

## Processing and AI image creation

Open **Image processing & overlays** to choose Floyd–Steinberg, Stucki, Burkes, or Sierra dithering; adjust exposure, contrast, and saturation; and choose a smart title/date, date-only, weather, or no overlay. Slider changes save automatically and refresh the preview. The smart overlay selects the less detailed edge of the image and adapts its panel/text contrast. Settings are saved in `data/config.json`.

The **AI create** tab can generate landscape (4:3) or portrait (3:4) images with OpenAI or Google Gemini. Gemini uses the official `google-genai` SDK, defaults to `gemini-nano-banana-2.1`, and requests 2K image generation with E Ink Spectra 6 composition guidance. Set `OPENAI_API_KEY` and/or `GEMINI_API_KEY` in `.env`, then restart the server; generated images are resized to 1600 × 1200 or 1200 × 1600, saved with uploads, and run through the app's normal display palette, dithering, and EPDGZ pipeline. Model names can be overridden with `OPENAI_IMAGE_MODEL` and `GEMINI_IMAGE_MODEL`. Image-generation API usage may incur provider charges.

## Generate and send via API

`POST /api/generate-and-push` accepts JSON with a required `text` field (1–2000 characters). If the text requests a movie/film poster or TV/series poster, the server searches TMDB for the title and uses the first matching poster. Otherwise, it sends the text as the prompt to the configured image-generation provider, preferring Gemini when available and OpenAI otherwise. For AI requests, optional `provider` (`google` or `openai`) and `orientation` (`portrait` or `landscape`) fields can override the defaults. Once the payload is validated, the endpoint responds with HTTP `202 Accepted`, echoing the original request in `payload` and providing a `requestId`; image generation, display preparation, and the frame upload continue in the background. Later failures are logged on the server and do not change the already returned response.

```sh
curl -X POST http://homeserver.local:3000/api/generate-and-push \
  -H 'Content-Type: application/json' \
  -d '{"text":"Make a movie poster for Dune"}'
```

For AI generation, send for example `{"text":"A bright red sailboat on a calm lake","provider":"google","orientation":"portrait"}`. The response acknowledges receipt only; it does not mean generation or upload has finished. The request ID is included in server logs for troubleshooting.

## Notes

This is intended for a trusted home network. Anyone who can reach the configuration page can change the selected image or upload a file. To run as a background service, use a macOS service manager such as `launchd` and point it at the virtual environment's `.venv/bin/uvicorn app:app --host 0.0.0.0 --port 3000` command.