# Prueba de carga de Voxlive

Este simulador abre oyentes WebSocket reales contra una sala de Voxlive. Para
probar el broadcast de audio debe existir un emisor real hablando en esa sala;
sin emisor, la prueba sólo valida conexiones abiertas.

## Preparación

Ejecutar preferentemente desde una VM con al menos 250 Mbps de red disponible:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r load-test/requirements.txt
```

## Audio automatizado con Fish

Con las variables `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID`,
`FISH_AUDIO_API_URL` y `FISH_AUDIO_MODEL` configuradas en `.env`, generar la
locución PCM inglesa:

```bash
python load-test/generate_fish_audio.py
```

En una primera terminal, iniciar el emisor automático usando un código de sala
nuevo. El Worker utiliza su secreto `GEMINI_API_KEY` para traducir:

```bash
python load-test/voxlive_audio_publisher.py --room 1234 --duration 330
```

Para probar OpenAI con exactamente el mismo audio, configurar el secreto
`OPENAI_API_KEY` del Worker y seleccionar el proveedor en el emisor:

```bash
python load-test/voxlive_audio_publisher.py --room 1234 --duration 330 --provider openai
```

También se puede abrir Voxlive en otro dispositivo, crear una sala, activar el
micrófono y hablar continuamente durante toda la prueba.

## Escalamiento recomendado

Reemplazar `1234` por el código real de la sala:

```bash
python load-test/voxlive_load_test.py --room 1234 --clients 10 --ramp 5 --duration 30 --require-audio
python load-test/voxlive_load_test.py --room 1234 --clients 50 --ramp 15 --duration 60 --require-audio
python load-test/voxlive_load_test.py --room 1234 --clients 100 --ramp 20 --duration 120 --require-audio
python load-test/voxlive_load_test.py --room 1234 --clients 200 --ramp 30 --duration 180 --require-audio
python load-test/voxlive_load_test.py --room 1234 --clients 400 --ramp 60 --duration 300 --require-audio --json-output voxlive-400.json
```

No conviene saltar directamente a 400: detener el escalamiento si aparecen
desconexiones, errores o secuencias de audio perdidas.

## Criterio sugerido

- 99% o más de conexiones exitosas.
- 99% o más de clientes recibiendo audio.
- Cero cierres inesperados.
- Cero frames de audio perdidos.
- Throughput cercano a 384 kbps por oyente mientras el audio PCM sea continuo.

`approximate_network_ms` compara el reloj de Cloudflare con el de la máquina de
prueba; sirve como orientación, pero no como medición exacta si los relojes no
están sincronizados.

Colab puede servir para una ejecución preliminar, pero una VM controlada entrega
resultados más repetibles y evita límites dinámicos del entorno administrado.

## Comparación de calidad con Groq Whisper

Groq Whisper se utiliza como transcriptor del audio español, no como traductor
inglés a español. Capturar la misma entrada con ambos motores:

```bash
python load-test/capture_translation.py --provider openai --output load-test/reports/openai-spanish.wav
python load-test/capture_translation.py --provider gemini --output load-test/reports/gemini-spanish.wav
python load-test/compare_with_groq.py
```

El informe queda en `load-test/reports/translation-comparison.md`. Requiere
`GROQ_API_KEY` y admite `GROQ_WHISPER_MODEL=whisper-large-v3` en `.env`.
