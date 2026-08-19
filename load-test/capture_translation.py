#!/usr/bin/env python3
"""Capture one complete Voxlive translation as a mono PCM16 WAV file."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import random
import ssl
import struct
import wave
from contextlib import suppress
from pathlib import Path
from urllib.parse import quote

import certifi
import websockets


INPUT_SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2
AUDIO_FRAME_MAGIC = 0x56584C31
AUDIO_HEADER = struct.Struct(">IIdI")


async def receive_guide_messages(websocket: websockets.ClientConnection) -> None:
    async for message in websocket:
        if not isinstance(message, str):
            continue
        data = json.loads(message)
        if data.get("type") == "translation_warning":
            raise RuntimeError(data.get("message", "The translation provider failed."))


async def receive_audio(
    websocket: websockets.ClientConnection,
    pcm: bytearray,
    sample_rates: set[int],
    transcripts: dict[str, str],
) -> None:
    async for message in websocket:
        if isinstance(message, str):
            data = json.loads(message)
            if data.get("type") == "transcript":
                transcript_id = str(data.get("id", "unknown"))
                transcripts[transcript_id] = data.get("translatedText") or data.get("text") or ""
            continue
        if len(message) < AUDIO_HEADER.size:
            raise RuntimeError("Received an invalid Voxlive audio frame.")
        magic, _sequence, _sent_at, sample_rate = AUDIO_HEADER.unpack_from(message)
        if magic != AUDIO_FRAME_MAGIC:
            raise RuntimeError("Received an unknown Voxlive audio frame format.")
        payload = message[AUDIO_HEADER.size:]
        if len(payload) % BYTES_PER_SAMPLE:
            raise RuntimeError("Received an unaligned PCM16 payload.")
        sample_rates.add(sample_rate)
        pcm.extend(payload)


async def run(args: argparse.Namespace) -> int:
    source_pcm = Path(args.audio).read_bytes()
    if not source_pcm or len(source_pcm) % BYTES_PER_SAMPLE:
        raise ValueError("The source fixture must contain raw little-endian PCM16 audio.")

    if args.source_seconds is not None:
        source_bytes = round(args.source_seconds * INPUT_SAMPLE_RATE * BYTES_PER_SAMPLE)
        source_pcm = source_pcm[:source_bytes - source_bytes % BYTES_PER_SAMPLE]

    chunk_bytes = round(INPUT_SAMPLE_RATE * BYTES_PER_SAMPLE * args.chunk_ms / 1_000)
    chunk_bytes -= chunk_bytes % BYTES_PER_SAMPLE
    silence_chunks = round(args.trailing_silence * 1_000 / args.chunk_ms)
    room = quote(args.room or str(random.randint(1000, 9999)), safe="")
    base_url = args.base_url.rstrip("/")
    guide_url = f"{base_url}/ws/room/{room}?role=guide&lang=en"
    listener_url = f"{base_url}/ws/room/{room}?role=visitor&lang=es&audio=binary"
    ssl_context = ssl.create_default_context(cafile=certifi.where()) if base_url.startswith("wss://") else None

    captured_pcm = bytearray()
    sample_rates: set[int] = set()
    transcripts: dict[str, str] = {}
    loop = asyncio.get_running_loop()

    print(
        f"Capturing gpt-realtime-translate: room={room} source={len(source_pcm) / (INPUT_SAMPLE_RATE * 2):.2f}s",
        flush=True,
    )

    async with websockets.connect(
        listener_url,
        compression=None,
        ping_interval=20,
        ping_timeout=20,
        max_size=None,
        ssl=ssl_context,
    ) as listener:
        audio_task = asyncio.create_task(receive_audio(listener, captured_pcm, sample_rates, transcripts))

        async with websockets.connect(
            guide_url,
            compression=None,
            ping_interval=20,
            ping_timeout=20,
            max_size=None,
            ssl=ssl_context,
        ) as guide:
            guide_task = asyncio.create_task(receive_guide_messages(guide))
            await guide.send(json.dumps({
                "type": "config",
                "provider": "openai",
                "nativeLanguage": "en",
            }))
            await asyncio.sleep(1)

            next_send = loop.time()
            for offset in range(0, len(source_pcm), chunk_bytes):
                chunk = source_pcm[offset:offset + chunk_bytes]
                if len(chunk) < chunk_bytes:
                    chunk += bytes(chunk_bytes - len(chunk))
                await guide.send(json.dumps({
                    "type": "audio_chunk",
                    "data": base64.b64encode(chunk).decode("ascii"),
                    "sampleRate": INPUT_SAMPLE_RATE,
                }, separators=(",", ":")))
                next_send += args.chunk_ms / 1_000
                await asyncio.sleep(max(0, next_send - loop.time()))

            silence = base64.b64encode(bytes(chunk_bytes)).decode("ascii")
            for _ in range(silence_chunks):
                await guide.send(json.dumps({
                    "type": "audio_chunk",
                    "data": silence,
                    "sampleRate": INPUT_SAMPLE_RATE,
                }, separators=(",", ":")))
                next_send += args.chunk_ms / 1_000
                await asyncio.sleep(max(0, next_send - loop.time()))

            await asyncio.sleep(args.drain_seconds)
            if guide_task.done():
                await guide_task
            guide_task.cancel()
            with suppress(asyncio.CancelledError):
                await guide_task

        audio_task.cancel()
        with suppress(asyncio.CancelledError):
            await audio_task

    if not captured_pcm:
        raise RuntimeError(f"{args.provider} produced no translated audio.")
    if len(sample_rates) != 1:
        raise RuntimeError(f"Expected one output sample rate, received: {sorted(sample_rates)}")

    sample_rate = sample_rates.pop()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(BYTES_PER_SAMPLE)
        wav.setframerate(sample_rate)
        wav.writeframes(captured_pcm)

    print(json.dumps({
        "provider": "openai",
        "room": room,
        "output": str(output),
        "sample_rate": sample_rate,
        "pcm_bytes": len(captured_pcm),
        "captured_audio_seconds": round(len(captured_pcm) / (sample_rate * BYTES_PER_SAMPLE), 2),
        "transcripts": list(transcripts.values()),
    }, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture translated Voxlive audio for quality review.")
    parser.add_argument("--output", required=True)
    parser.add_argument("--room")
    parser.add_argument("--audio", default="load-test/generated/english_test_16k.pcm")
    parser.add_argument("--source-seconds", type=float)
    parser.add_argument("--chunk-ms", type=float, default=128)
    parser.add_argument("--trailing-silence", type=float, default=2)
    parser.add_argument("--drain-seconds", type=float, default=8)
    parser.add_argument("--base-url", default="wss://voxlive-backend.davidtroncosop.workers.dev")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parse_args())))
