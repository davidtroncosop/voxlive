#!/usr/bin/env python3
"""Check intelligibility of Fish Audio fixtures before/after the local Opus path."""
import concurrent.futures
import json
import re
import ssl
import unicodedata
import urllib.request
import urllib.error
import uuid
from pathlib import Path

import certifi
from generate_fish_audio import load_env


def words(text):
    text = ''.join(c for c in unicodedata.normalize('NFD', text.lower()) if not unicodedata.combining(c))
    return re.findall(r'\w+', text)


def word_error_rate(reference, actual):
    expected, observed = words(reference), words(actual)
    row = list(range(len(observed) + 1))
    for i, a in enumerate(expected, 1):
        new = [i]
        for j, b in enumerate(observed, 1):
            new.append(min(new[-1] + 1, row[j] + 1, row[j - 1] + (a != b)))
        row = new
    return row[-1] / max(1, len(expected))


def transcribe(env, language, version):
    path = Path(f'load-test/reports/fish-{language}-{version}.wav')
    boundary = 'Voxlive' + uuid.uuid4().hex
    fields = {'model': env.get('GROQ_WHISPER_MODEL', 'whisper-large-v3'),
              'language': language, 'response_format': 'json', 'temperature': '0'}
    parts = []
    for key, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
    parts.extend([path.read_bytes(), f'\r\n--{boundary}--\r\n'.encode()])
    request = urllib.request.Request('https://api.groq.com/openai/v1/audio/transcriptions',
        data=b''.join(parts), headers={'Authorization': 'Bearer ' + env['GROQ_API_KEY'],
        'Content-Type': 'multipart/form-data; boundary=' + boundary, 'User-Agent': 'Voxlive-Audio-Check/1.0'}, method='POST')
    try:
        with urllib.request.urlopen(request, context=ssl.create_default_context(cafile=certifi.where()), timeout=60) as response:
            return json.load(response)['text']
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Transcription HTTP {error.code}: {error.read().decode(errors="replace")[:400]}') from None


def main():
    env = load_env(Path('.env'))
    if not env.get('GROQ_API_KEY'):
        raise RuntimeError('GROQ_API_KEY is needed for the optional intelligibility check')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {(lang, version): pool.submit(transcribe, env, lang, version)
                   for lang in ['es', 'en'] for version in ['original', 'opus']}
        transcripts = {key: future.result() for key, future in futures.items()}
    results = []
    for language in ['es', 'en']:
        original, opus = transcripts[(language, 'original')], transcripts[(language, 'opus')]
        wer = word_error_rate(original, opus)
        results.append({'language': language, 'original': original, 'opus': opus,
                        'word_error_rate_vs_original': wer, 'passed': wer <= 0.15})
    Path('load-test/reports/fish-opus-intelligibility.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps(results, ensure_ascii=False, indent=2))
    if not all(result['passed'] for result in results):
        raise RuntimeError('Opus transcription differs from the original; inspect the WAV files')


if __name__ == '__main__':
    main()
