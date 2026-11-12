
#!/usr/bin/env python3

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone

import pyatv
from pyatv.exceptions import NotSupportedError
from pyatv.storage.file_storage import FileStorage

APPLE_TV_NAME = "Cash me outside"


def enum_name(value):
    """Convert enum values to readable strings."""
    if value is None:
        return None
    return getattr(value, "name", str(value))


def classify_media(media_type):
    """Provide a convenient media classification."""
    mapping = {
        "Music": "music",
        "TV": "tv_show",
        "Video": "video",
        "Unknown": "unknown",
    }
    return mapping.get(media_type, "unknown")


def get_metadata(config, atv, playing):
    """Convert pyatv Playing object into JSON-friendly data."""

    try:
        app = atv.metadata.app
    except NotSupportedError:
        app = None

    media_type = enum_name(playing.media_type)

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),

        "device": {
            "name": config.name,
            "address": str(config.address),
        },

        "playback": {
            "state": enum_name(playing.device_state),
            "media_type": media_type,
            "category": classify_media(media_type),

            "title": playing.title,
            "artist": playing.artist,
            "album": playing.album,
            "genre": playing.genre,

            "series_name": playing.series_name,
            "season_number": playing.season_number,
            "episode_number": playing.episode_number,

            "content_identifier": playing.content_identifier,
            "itunes_store_identifier": (
                playing.itunes_store_identifier
            ),

            "position": playing.position,
            "total_time": playing.total_time,

            "shuffle": enum_name(playing.shuffle),
            "repeat": enum_name(playing.repeat),

            "hash": playing.hash,
        },

        "app": {
            "name": app.name if app else None,
            "identifier": app.identifier if app else None,
        },
    }


async def get_now_playing(host=None, name=APPLE_TV_NAME):
    """Discover the configured Apple TV and return its current media metadata."""
    loop = asyncio.get_running_loop()

    storage = FileStorage.default_storage(loop)
    await storage.load()

    devices = await pyatv.scan(
        loop,
        timeout=5,
        hosts=[host] if host else None,
        storage=storage,
    )

    if not devices:
        raise RuntimeError("No Apple TVs found.")

    matches = [
        device for device in devices
        if device.name.casefold() == name.casefold()
    ]

    if not matches:
        raise RuntimeError(f"No Apple TV named {name!r} found.")

    if len(matches) > 1:
        raise RuntimeError(
            f"Multiple Apple TVs named {name!r} found; specify --host to select one."
        )

    config = matches[0]
    atv = None

    try:
        atv = await pyatv.connect(
            config,
            loop,
            storage=storage
        )

        playing = await atv.metadata.playing()

        return get_metadata(config, atv, playing)
    finally:
        if atv:
            atv.close()


async def main():
    parser = argparse.ArgumentParser(
        description="Get currently playing Apple TV metadata"
    )
    parser.add_argument("--host", help="Apple TV IP address (optional)")
    parser.add_argument(
        "--name",
        default=APPLE_TV_NAME,
        help=f"Apple TV device name (default: {APPLE_TV_NAME})"
    )
    args = parser.parse_args()

    print("Discovering Apple TV...", file=sys.stderr)
    try:
        result = await get_now_playing(args.host, args.name)
    except Exception as ex:
        print(f"Error: {ex}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
