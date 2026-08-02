#!/usr/bin/env python3
"""Transcribe Gemini and OpenAI Spanish outputs with Groq Whisper."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def transcribe(file_path: Path, api_key: str, model: str) -> dict:
    command = [
        "curl",
        "--fail-with-body",
        "--silent",
        "--show-error",
        "https://api.groq.com/openai/v1/audio/transcriptions",
        "-H", f"Authorization: Bearer {api_key}",
        "-F", f"file=@{file_path}",
        "-F", f"model={model}",
        "-F", "language=es",
        "-F", "response_format=verbose_json",
        "-F", "temperature=0",
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
    if result.returncode != 0:
        detail = (result.stdout or result.stderr).strip()[:1000]
        raise RuntimeError(f"Groq transcription failed: {detail}")
    return json.loads(result.stdout)


def average_log_probability(result: dict) -> float | None:
    values = [
        segment.get("avg_logprob")
        for segment in result.get("segments", [])
        if isinstance(segment.get("avg_logprob"), (int, float))
    ]
    return round(sum(values) / len(values), 4) if values else None


def main() -> int:
    args = parse_args()
    env = load_env(Path(args.env))
    api_key = env.get("GROQ_API_KEY", "")
    model = env.get("GROQ_WHISPER_MODEL", "whisper-large-v3")
    if not api_key:
        raise ValueError("GROQ_API_KEY is missing from the environment file.")

    openai_result = transcribe(Path(args.openai_audio), api_key, model)
    gemini_result = transcribe(Path(args.gemini_audio), api_key, model)
    source = Path(args.source_text).read_text().strip()

    report = Path(args.report)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(
        f"""# Comparación de traducción Voxlive

Evaluador de audio: `{model}` mediante el endpoint de transcripción de Groq (`language=es`).

> La probabilidad de Whisper indica qué tan claramente pudo reconocer el audio. No mide por sí sola la fidelidad de la traducción.

## Texto original en inglés

{source}

## OpenAI GPT Realtime Translate

Promedio `avg_logprob` de Whisper: `{average_log_probability(openai_result)}`

{openai_result.get('text', '').strip()}

## Google Gemini 3.5 Live Translate

Promedio `avg_logprob` de Whisper: `{average_log_probability(gemini_result)}`

{gemini_result.get('text', '').strip()}
""",
        encoding="utf-8",
    )

    print(json.dumps({
        "model": model,
        "report": str(report),
        "openai_transcript": openai_result.get("text", "").strip(),
        "gemini_transcript": gemini_result.get("text", "").strip(),
        "openai_avg_logprob": average_log_probability(openai_result),
        "gemini_avg_logprob": average_log_probability(gemini_result),
    }, indent=2, ensure_ascii=False))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare translated audio using Groq Whisper transcription.")
    parser.add_argument("--env", default=".env")
    parser.add_argument("--source-text", default="load-test/english_test_script.txt")
    parser.add_argument("--openai-audio", default="load-test/reports/openai-spanish.wav")
    parser.add_argument("--gemini-audio", default="load-test/reports/gemini-spanish.wav")
    parser.add_argument("--report", default="load-test/reports/translation-comparison.md")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(main())
