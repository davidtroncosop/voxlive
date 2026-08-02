# Resultados de carga de Voxlive

Fecha: 1 de agosto de 2026.

Fuente: locución inglesa PCM16 mono de 16 kHz generada con Fish Audio y enviada
en tiempo real al Worker de producción. Salida: traducción española PCM16 mono
de 24 kHz producida por Gemini y distribuida como WebSocket binario.

| Oyentes | Conectados | Con audio | Frames perdidos | Cierres | Mbps agregados | Red p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 10 | 0 | 0 | 3,34 | 75,84 ms |
| 50 | 50 | 50 | 0 | 0 | 16,55 | 58,93 ms |
| 100 | 100 | 100 | 0 | 0 | 32,90 | 72,57 ms |
| 200 | 200 | 200 | 0 | 0 | 65,29 | 123,57 ms |
| 400 | 400 | 400 | 0 | 0 | 127,42 | 266,15 ms |

## Prueba de 400

- Rampa: 30 segundos.
- Periodo estable: 60 segundos.
- Datos recibidos: 1.367,10 MiB.
- Promedio por oyente: 382,63 kbps de PCM.
- Conexión p95: 249,67 ms.
- Intervalo entre chunks p95: 324,46 ms.
- Reconexiones del emisor: 0.
- Resultado: aprobado.

Esta ejecución utiliza 400 conexiones desde una sola máquina y una sola red.
Valida el backend, el broadcast y el ancho de banda de Internet disponible, pero
no reproduce la contención de radio de 400 teléfonos conectados a los access
points del auditorio. Esa capacidad todavía debe validarse en el piso −1.
