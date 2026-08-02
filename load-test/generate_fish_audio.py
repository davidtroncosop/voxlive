#!/usr/bin/env python3
"""Generate a reproducible English PCM fixture using Fish Audio."""

from __future__ import annotations

import argparse
import json
import ssl
import urllib.error
import urllib.request
from pathlib import Path

import certifi


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Voxlive's English test fixture with Fish Audio.")
    parser.add_argument("--env", default=".env")
    parser.add_argument("--text", default="load-test/english_test_script.txt")
    parser.add_argument("--output", default="load-test/generated/english_test_16k.pcm")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env = load_env(Path(args.env))
    required = ("FISH_AUDIO_API_KEY", "FISH_AUDIO_VOICE_ID")
    missing = [key for key in required if not env.get(key)]
    if missing:
        raise ValueError(f"Missing configuration: {', '.join(missing)}")

    text = Path(args.text).read_text().strip()
    if not text:
        raise ValueError("The English test script is empty.")

    payload = json.dumps({
        "text": text,
        "reference_id": env["FISH_AUDIO_VOICE_ID"],
        "format": "pcm",
        "sample_rate": 16_000,
        "normalize": True,
        "latency": "normal",
        "chunk_length": 200,
        "prosody": {
            "speed": 1.0,
            "volume": 0,
            "normalize_loudness": True,
        },
    }).encode()

    request = urllib.request.Request(
        env.get("FISH_AUDIO_API_URL", "https://api.fish.audio/v1/tts"),
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {env['FISH_AUDIO_API_KEY']}",
            "Content-Type": "application/json",
            "model": env.get("FISH_AUDIO_MODEL", "s2-pro"),
        },
    )
    timeout = float(env.get("FISH_AUDIO_TIMEOUT_SECONDS", "900"))
    context = ssl.create_default_context(cafile=certifi.where())

    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            pcm = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        raise RuntimeError(f"Fish Audio returned HTTP {error.code}: {detail}") from error

    if not pcm or len(pcm) % 2:
        raise RuntimeError("Fish Audio returned an invalid PCM16 payload.")

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(pcm)
    duration = len(pcm) / (16_000 * 2)
    print(json.dumps({
        "output": str(output),
        "bytes": len(pcm),
        "sample_rate": 16_000,
        "channels": 1,
        "duration_seconds": round(duration, 2),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
