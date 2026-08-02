#!/usr/bin/env python3
"""Controlled WebSocket listener load test for Voxlive."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import ssl
import struct
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import quote

import certifi
import websockets
from websockets.exceptions import ConnectionClosed


AUDIO_FRAME_MAGIC = 0x56584C31  # "VXL1"
AUDIO_HEADER = struct.Struct(">IIdI")
PROGRESS_INTERVAL_SECONDS = 5
MAX_INTERVAL_SAMPLES_PER_CLIENT = 5_000
HEARTBEAT_INTERVAL_SECONDS = 15


@dataclass
class ClientResult:
    client_id: int
    connected: bool = False
    connection_ms: float | None = None
    connected_at: float | None = None
    binary_frames: int = 0
    binary_bytes: int = 0
    pcm_bytes: int = 0
    text_messages: int = 0
    pings_sent: int = 0
    pongs_received: int = 0
    missing_frames: int = 0
    first_audio_ms: float | None = None
    unexpected_close: bool = False
    error: str | None = None
    last_sequence: int | None = None
    last_frame_at: float | None = None
    interarrival_ms: list[float] = field(default_factory=list)
    approximate_network_ms: list[float] = field(default_factory=list)


def percentile(values: list[float], percent: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered) - 1) * percent
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return round(ordered[low], 2)
    weight = rank - low
    return round(ordered[low] * (1 - weight) + ordered[high] * weight, 2)


def parse_audio_frame(message: bytes) -> tuple[int, float, int, int]:
    if len(message) < AUDIO_HEADER.size:
        raise ValueError("binary frame shorter than Voxlive header")

    magic, sequence, sent_at, sample_rate = AUDIO_HEADER.unpack_from(message)
    pcm_bytes = len(message) - AUDIO_HEADER.size
    if magic != AUDIO_FRAME_MAGIC:
        raise ValueError("unknown binary frame magic")
    if sample_rate < 8_000 or sample_rate > 96_000 or pcm_bytes % 2:
        raise ValueError("invalid PCM frame")

    return sequence, sent_at, sample_rate, pcm_bytes


async def simulate_listener(
    result: ClientResult,
    url: str,
    start_at: float,
    deadline: float,
    ssl_context: ssl.SSLContext | None,
) -> None:
    loop = asyncio.get_running_loop()
    await asyncio.sleep(max(0, start_at - loop.time()))
    connection_started = loop.time()

    try:
        async with websockets.connect(
            url,
            compression=None,
            open_timeout=15,
            close_timeout=3,
            ping_interval=20,
            ping_timeout=20,
            max_size=None,
            max_queue=32,
            ssl=ssl_context,
        ) as websocket:
            result.connected = True
            result.connected_at = loop.time()
            result.connection_ms = (result.connected_at - connection_started) * 1_000
            next_ping_at = loop.time() + HEARTBEAT_INTERVAL_SECONDS

            while loop.time() < deadline:
                remaining = deadline - loop.time()
                try:
                    message = await asyncio.wait_for(websocket.recv(), timeout=min(5, remaining))
                except asyncio.TimeoutError:
                    if loop.time() >= next_ping_at:
                        await websocket.send(json.dumps({"type": "ping", "timestamp": int(time.time() * 1_000)}))
                        result.pings_sent += 1
                        next_ping_at = loop.time() + HEARTBEAT_INTERVAL_SECONDS
                    continue
                except ConnectionClosed as error:
                    if loop.time() < deadline - 1:
                        result.unexpected_close = True
                        result.error = f"closed {error.code}: {error.reason}"
                    break

                if isinstance(message, str):
                    result.text_messages += 1
                    try:
                        data = json.loads(message)
                        if data.get("type") == "pong":
                            result.pongs_received += 1
                    except json.JSONDecodeError:
                        pass
                    if loop.time() >= next_ping_at:
                        await websocket.send(json.dumps({"type": "ping", "timestamp": int(time.time() * 1_000)}))
                        result.pings_sent += 1
                        next_ping_at = loop.time() + HEARTBEAT_INTERVAL_SECONDS
                    continue

                received_at = loop.time()
                sequence, sent_at, _sample_rate, pcm_bytes = parse_audio_frame(message)
                result.binary_frames += 1
                result.binary_bytes += len(message)
                result.pcm_bytes += pcm_bytes

                if result.first_audio_ms is None and result.connected_at is not None:
                    result.first_audio_ms = (received_at - result.connected_at) * 1_000

                if result.last_sequence is not None:
                    expected = (result.last_sequence + 1) & 0xFFFFFFFF
                    missing = (sequence - expected) & 0xFFFFFFFF
                    if sequence != expected and missing < 0x80000000:
                        result.missing_frames += missing
                result.last_sequence = sequence

                if result.last_frame_at is not None and len(result.interarrival_ms) < MAX_INTERVAL_SAMPLES_PER_CLIENT:
                    result.interarrival_ms.append((received_at - result.last_frame_at) * 1_000)
                result.last_frame_at = received_at

                network_ms = time.time() * 1_000 - sent_at
                if -1_000 <= network_ms <= 60_000 and len(result.approximate_network_ms) < MAX_INTERVAL_SAMPLES_PER_CLIENT:
                    result.approximate_network_ms.append(network_ms)

                if loop.time() >= next_ping_at:
                    await websocket.send(json.dumps({"type": "ping", "timestamp": int(time.time() * 1_000)}))
                    result.pings_sent += 1
                    next_ping_at = loop.time() + HEARTBEAT_INTERVAL_SECONDS

    except Exception as error:  # The result captures failures without spamming per-client logs.
        result.error = f"{type(error).__name__}: {error}"


async def print_progress(results: list[ClientResult], deadline: float) -> None:
    loop = asyncio.get_running_loop()
    while loop.time() < deadline:
        await asyncio.sleep(min(PROGRESS_INTERVAL_SECONDS, max(0, deadline - loop.time())))
        connected = sum(result.connected for result in results)
        frames = sum(result.binary_frames for result in results)
        received_mib = sum(result.binary_bytes for result in results) / (1024 * 1024)
        failures = sum(result.error is not None for result in results)
        print(
            f"progress connected={connected}/{len(results)} "
            f"audio_frames={frames} received={received_mib:.1f}MiB failures={failures}",
            flush=True,
        )


def summarize(results: list[ClientResult], elapsed: float, deadline: float) -> dict[str, object]:
    connected = [result for result in results if result.connected]
    audio_clients = [result for result in connected if result.binary_frames > 0]
    connection_times = [result.connection_ms for result in connected if result.connection_ms is not None]
    first_audio_times = [result.first_audio_ms for result in audio_clients if result.first_audio_ms is not None]
    intervals = [value for result in audio_clients for value in result.interarrival_ms]
    network_times = [value for result in audio_clients for value in result.approximate_network_ms]
    total_binary_bytes = sum(result.binary_bytes for result in results)
    total_pcm_bytes = sum(result.pcm_bytes for result in results)
    listener_seconds = sum(
        max(0, deadline - result.connected_at)
        for result in connected
        if result.connected_at is not None
    )

    failures = [
        {"client_id": result.client_id, "error": result.error}
        for result in results
        if result.error is not None
    ]

    return {
        "requested_clients": len(results),
        "connected_clients": len(connected),
        "connection_success_percent": round(len(connected) / len(results) * 100, 2),
        "audio_clients": len(audio_clients),
        "audio_coverage_percent": round(len(audio_clients) / len(connected) * 100, 2) if connected else 0,
        "unexpected_closes": sum(result.unexpected_close for result in results),
        "missing_audio_frames": sum(result.missing_frames for result in results),
        "binary_frames": sum(result.binary_frames for result in results),
        "heartbeats_sent": sum(result.pings_sent for result in results),
        "heartbeats_received": sum(result.pongs_received for result in results),
        "received_mib": round(total_binary_bytes / (1024 * 1024), 2),
        "aggregate_mbps": round(total_binary_bytes * 8 / max(elapsed, 0.001) / 1_000_000, 2),
        "average_listener_kbps": round(total_pcm_bytes * 8 / listener_seconds / 1_000, 2) if listener_seconds else 0,
        "connection_ms_p50": percentile(connection_times, 0.50),
        "connection_ms_p95": percentile(connection_times, 0.95),
        "first_audio_ms_p50": percentile(first_audio_times, 0.50),
        "first_audio_ms_p95": percentile(first_audio_times, 0.95),
        "interarrival_ms_p50": percentile(intervals, 0.50),
        "interarrival_ms_p95": percentile(intervals, 0.95),
        "approximate_network_ms_p50": percentile(network_times, 0.50),
        "approximate_network_ms_p95": percentile(network_times, 0.95),
        "failures": failures[:20],
        "failure_count": len(failures),
    }


async def run(args: argparse.Namespace) -> int:
    if args.clients < 1 or args.clients > 2_000:
        raise ValueError("--clients must be between 1 and 2000")
    if args.duration < 5 or args.ramp < 0:
        raise ValueError("--duration must be at least 5 seconds and --ramp cannot be negative")

    room = quote(args.room, safe="")
    language = quote(args.language, safe="")
    base_url = args.base_url.rstrip("/")
    url = f"{base_url}/ws/room/{room}?role=visitor&lang={language}&audio=binary"
    ssl_context = ssl.create_default_context(cafile=certifi.where()) if base_url.startswith("wss://") else None

    loop = asyncio.get_running_loop()
    test_started = loop.time()
    deadline = test_started + args.ramp + args.duration
    ramp_step = args.ramp / max(args.clients - 1, 1)
    results = [ClientResult(client_id=index + 1) for index in range(args.clients)]

    print(
        f"Starting controlled test: clients={args.clients} ramp={args.ramp}s "
        f"steady={args.duration}s room={args.room}",
        flush=True,
    )
    tasks = [
        asyncio.create_task(
            simulate_listener(result, url, test_started + index * ramp_step, deadline, ssl_context)
        )
        for index, result in enumerate(results)
    ]
    progress = asyncio.create_task(print_progress(results, deadline))
    await asyncio.gather(*tasks)
    await progress

    elapsed = loop.time() - test_started
    summary = summarize(results, args.ramp + args.duration, deadline)
    summary.update({
        "room": args.room,
        "language": args.language,
        "ramp_seconds": args.ramp,
        "steady_seconds": args.duration,
        "elapsed_seconds": round(elapsed, 2),
    })
    print(json.dumps(summary, indent=2, ensure_ascii=False))

    if args.json_output:
        output = Path(args.json_output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({
            "summary": summary,
            "clients": [asdict(result) for result in results],
        }, indent=2, ensure_ascii=False))
        print(f"Detailed report written to {output}")

    passed = (
        float(summary["connection_success_percent"]) >= args.minimum_success
        and int(summary["unexpected_closes"]) == 0
        and int(summary["missing_audio_frames"]) == 0
    )
    if args.require_audio:
        passed = passed and float(summary["audio_coverage_percent"]) >= args.minimum_success

    print("RESULT: PASS" if passed else "RESULT: FAIL")
    return 0 if passed else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Simulate Voxlive WebSocket listeners.")
    parser.add_argument("--room", required=True, help="Room code created by the real transmitter.")
    parser.add_argument("--clients", type=int, default=10)
    parser.add_argument("--ramp", type=float, default=10, help="Seconds used to connect all clients.")
    parser.add_argument("--duration", type=float, default=60, help="Steady-state seconds after the ramp.")
    parser.add_argument("--language", default="es")
    parser.add_argument(
        "--base-url",
        default="wss://voxlive-backend.davidtroncosop.workers.dev",
    )
    parser.add_argument("--minimum-success", type=float, default=99.0)
    parser.add_argument("--require-audio", action="store_true")
    parser.add_argument("--json-output", help="Optional detailed JSON report path.")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parse_args())))
