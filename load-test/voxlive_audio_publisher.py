#!/usr/bin/env python3
"""Publish a PCM fixture to Voxlive at the browser's real-time cadence."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import ssl
from contextlib import suppress
from pathlib import Path
from urllib.parse import quote

import certifi
import websockets
from websockets.exceptions import ConnectionClosed


SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2


async def receive_server_messages(websocket: websockets.ClientConnection) -> None:
    try:
        async for message in websocket:
            if not isinstance(message, str):
                continue
            data = json.loads(message)
            if data.get("type") == "translation_warning":
                print(f"WARNING: {data.get('message')}", flush=True)
    except ConnectionClosed:
        return


async def run(args: argparse.Namespace) -> int:
    pcm = Path(args.audio).read_bytes()
    if not pcm or len(pcm) % BYTES_PER_SAMPLE:
        raise ValueError("The audio fixture must contain raw little-endian PCM16 samples.")

    chunk_bytes = round(SAMPLE_RATE * BYTES_PER_SAMPLE * args.chunk_ms / 1_000)
    chunk_bytes -= chunk_bytes % BYTES_PER_SAMPLE
    if chunk_bytes <= 0:
        raise ValueError("--chunk-ms is too small")

    room = quote(args.room, safe="")
    url = f"{args.base_url.rstrip('/')}/ws/room/{room}?role=guide&lang=en"
    ssl_context = ssl.create_default_context(cafile=certifi.where()) if url.startswith("wss://") else None
    loop = asyncio.get_running_loop()
    started: float | None = None
    next_send = 0.0
    offset = 0
    chunks = 0
    payload_bytes = 0
    reconnects = 0

    print(
        f"Publishing English PCM to room {args.room}: duration={args.duration}s "
        f"chunk={args.chunk_ms}ms fixture={len(pcm) / (SAMPLE_RATE * BYTES_PER_SAMPLE):.2f}s",
        flush=True,
    )

    while started is None or loop.time() - started < args.duration:
        receiver: asyncio.Task[None] | None = None
        try:
            async with websockets.connect(
                url,
                compression=None,
                open_timeout=15,
                close_timeout=3,
                ping_interval=20,
                ping_timeout=20,
                max_size=None,
                ssl=ssl_context,
            ) as websocket:
                await websocket.send(json.dumps({
                    "type": "config",
                    "nativeLanguage": "en",
                    "provider": "openai",
                }))
                receiver = asyncio.create_task(receive_server_messages(websocket))

                if started is None:
                    await asyncio.sleep(args.start_delay)
                    started = loop.time()
                next_send = loop.time()

                while loop.time() - started < args.duration:
                    chunk = pcm[offset:offset + chunk_bytes]
                    if len(chunk) < chunk_bytes:
                        remaining = len(chunk)
                        chunk += pcm[:chunk_bytes - remaining]
                        offset = chunk_bytes - remaining
                    else:
                        offset += chunk_bytes
                        if offset >= len(pcm):
                            offset = 0

                    await websocket.send(json.dumps({
                        "type": "audio_chunk",
                        "data": base64.b64encode(chunk).decode("ascii"),
                        "sampleRate": SAMPLE_RATE,
                    }, separators=(",", ":")))
                    chunks += 1
                    payload_bytes += len(chunk)

                    next_send += args.chunk_ms / 1_000
                    await asyncio.sleep(max(0, next_send - loop.time()))

        except (ConnectionClosed, OSError, asyncio.TimeoutError) as error:
            if started is not None and loop.time() - started >= args.duration:
                break
            reconnects += 1
            print(f"Publisher connection lost ({type(error).__name__}); reconnecting...", flush=True)
            await asyncio.sleep(1)
        finally:
            if receiver is not None:
                receiver.cancel()
                with suppress(asyncio.CancelledError):
                    await receiver

    print(json.dumps({
        "room": args.room,
        "chunks_sent": chunks,
        "pcm_mib_sent": round(payload_bytes / (1024 * 1024), 2),
        "duration_seconds": args.duration,
        "reconnections": reconnects,
    }, indent=2))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send English PCM to a Voxlive room in real time.")
    parser.add_argument("--room", required=True)
    parser.add_argument("--audio", default="load-test/generated/english_test_16k.pcm")
    parser.add_argument("--duration", type=float, default=120)
    parser.add_argument("--chunk-ms", type=float, default=128)
    parser.add_argument("--start-delay", type=float, default=2)
    parser.add_argument(
        "--base-url",
        default="wss://voxlive-backend.davidtroncosop.workers.dev",
    )
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parse_args())))
