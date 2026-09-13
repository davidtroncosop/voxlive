## Acceso del guía y recuperación de traducción

El formulario de guía pide una clave. El Worker valida `codex` en cada entrada
y reconexión; los visitantes siguen entrando sin clave. Se puede cambiar desde
el servidor mediante el secreto `GUIDE_PASSWORD`. La clave no se guarda en el
almacenamiento del navegador ni se devuelve en los mensajes de estado.

Las sesiones de traducción reintentan automáticamente por idioma después de
fallos de conexión, errores del proveedor o un inicio sin respuesta durante
10 segundos. Las esperas son de 1, 2, 4, 8, 16 y hasta 30 segundos. Los intentos
se detienen cuando ya no hay guía u oyentes de ese idioma. El audio perdido
durante una interrupción no se recupera; se retoma la transmisión en vivo.

`npm run test:recovery` verifica la clave, reconexiones del guía y fallos
simulados en ambas direcciones: inglés → español y español → inglés. No usa
claves de IA reales ni valida la calidad de la traducción del proveedor.
El idioma de origen se selecciona en el formulario del guía.

# Voxlive: audio Opus

Los visitantes nuevos solicitan `audio=opus`. El Worker comprime una vez por
idioma con libopus: mono, 24 kHz, objetivo de 24 kbps con VBR restringido y paquetes de 40 ms. También se
comprime el audio original para visitantes que escuchan el idioma del guía.
El enlace del micrófono al servidor sigue en PCM.

Los modos anteriores (`binary`, `binary24`, `json`) siguen disponibles. El
cliente distingue PCM y Opus por la cabecera y vuelve a PCM si falla su
decodificador. El modo de subtítulos no recibe paquetes de audio.

Durante voz continua, el presupuesto nominal es de 3.000 bytes Opus y 500
bytes de cabeceras por segundo: 28 kbps por oyente, aproximadamente 11,2 Mbps
para 400. El bitrate variable puede fluctuar; las locuciones Fish medidas
consumieron 27,36–27,73 kbps incluyendo cabeceras. Se excluyen WebSocket, TLS,
TCP/IP y retransmisiones.

DTX reduce el tamaño de los paquetes durante silencios sin omitirlos, por lo
que el receptor conserva el tiempo de reproducción. No se corta audio con un
umbral manual. La prueba de tres segundos de silencio produjo 417 bytes de
Opus más 1.500 bytes de cabeceras, frente a 9.000 bytes Opus en CBR.

El encoder acumula hasta 40 ms para formar un paquete. Si deja de llegar audio,
se completa con silencio el último bloque pendiente tras 40 ms de inactividad
para no perder finales de palabras. Los clientes anteriores que decodifican
Opus siguen siendo compatibles con los paquetes de 40 ms (cabecera VXL2).

El servidor mantiene un índice de oyentes por idioma, agrupa las notificaciones
de estado que ocurren en 100 ms y evita conversiones base64 para audio original.
Los teléfonos adaptan el búfer entre 60 y 240 ms según la variación en llegadas,
limitan la cola a 800 ms y cancelan audio viejo cuando necesitan ponerse al día.
Las estadísticas se envían dentro del ping existente, cada 10 segundos; el
panel del guía recibe agregados en su propio ping. No se guardan permanentemente.

Validación local (Node 22.6 o posterior):

```sh
npm run build
npm run lint
npx tsc --noEmit -p worker/tsconfig.json
npm run test:opus
# Prueba corta con 450 oyentes simulados:
OPUS_TEST_LISTENERS=450 npm run test:opus
```

La prueba usa el runtime local de Cloudflare, audio sintético y el decodificador
real del cliente. Verifica paquetes compartidos, bitrate, audio decodificado,
compatibilidad PCM, subtítulos, cambios de modo y ciclo de vida del decoder.
La prueba corta con 450 oyentes pasó: todos recibieron los mismos 25 paquetes
de un segundo de audio sintético. No llama al proveedor de traducción ni publica cambios. No sustituye una prueba
de duración completa con 450 teléfonos ni la validación en Safari/iOS y Android.
Para activar Opus en producción deben actualizarse el Worker y el frontend;
publicar primero el Worker permite conservar clientes anteriores.

La adaptación de la biblioteca para Workers está documentada en
[worker/src/vendor/README.md](worker/src/vendor/README.md).

---

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Prueba de voz con Fish Audio antes de publicar

Las claves se leen desde `.env` y no se incluyen en el frontend. Generar dos
locuciones breves usando el entorno Python de las pruebas de carga:

```sh
.venv/bin/python load-test/generate_fish_audio.py --text load-test/opus_test_es.txt --output load-test/generated/opus-fish-es-16k.pcm
.venv/bin/python load-test/generate_fish_audio.py --text load-test/opus_test_en.txt --output load-test/generated/opus-fish-en-16k.pcm
npm run test:fish
.venv/bin/python load-test/transcribe_opus_check.py
```

La última comprobación requiere `GROQ_API_KEY` y compara la transcripción de
la locución original con la del audio decodificado. No recibe el texto esperado
como pista. Los WAV originales y comprimidos quedan en `load-test/reports/`.
La prueba de voz compara además cada paquete contra el codificador público de
opusscript y comprueba la correlación de la señal. Así detecta audio corrupto
incluso cuando los paquetes Opus son válidos. No evalúa una traducción de la IA
ni sustituye el ensayo con teléfonos reales.

## Regresión y carga tras las optimizaciones

```sh
npm run test:audio
npm run test:audio-load
```

La carga usa 450 conexiones locales durante 60 segundos, con locución Fish
repetida en tiempo real. Se puede cambiar con `OPUS_LOAD_CLIENTS` y
`OPUS_LOAD_SECONDS` (máximo 600). El informe se guarda en
`load-test/reports/optimized-load.json`. No valida la capacidad del Wi-Fi del
recinto ni la calidad de una traducción de IA en vivo.

Resultado local (12/09/2026): 450 WebSockets TCP, repartidos entre cuatro
hilos de simulación, recibieron 675.000 paquetes en 60 segundos sin pérdidas
ni desconexiones durante la transmisión. Tráfico de aplicación: 12,57 Mbps
para 450 oyentes; máximo desde envío del servidor hasta recepción: 542 ms.
Esta medida excluye captura, traducción, reproducción y Wi-Fi del recinto.
