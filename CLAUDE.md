# Notas de proceso

- Si al trabajar en una tarea encuentras un problema adicional no relacionado
  con lo que se te pidió (por ejemplo, otra vulnerabilidad reportada por
  `npm audit` distinta a la que estabas arreglando), resuélvelo en un commit
  separado del commit de la tarea original, y dilo explícitamente en tu
  resumen final (qué encontraste, en qué commit quedó). No lo mezcles en el
  mismo commit aunque el arreglo sea pequeño.

# Pendientes

- **EN CURSO (rama `chore/node-trixie`, sin fusionar): migración de la imagen
  a `node:24-trixie-slim`.** Sustituye a `node:20-bookworm-slim` (Node 20 llegó
  a fin de vida el 2026-04-30). Node 24 tiene soporte hasta el 2028-04-30; se
  descartó Node 22 porque acaba el 2027-04-30 (fuente: `nodejs/Release`,
  schedule.json). Cambios de trixie frente a bookworm: Ghostscript 10.0.0 →
  10.05.1, Python 3.11 → 3.13 (PyMuPDF 1.28.2 se instala desde la rueda abi3 en
  el venv), poppler-utils 22.12 → 25.03 (el código no lo usa). multer, p-limit,
  cors y express no ponen restricciones de versión de Node que afecten. Pendiente
  antes de fusionar: validar la rama en un servicio temporal de Render con
  `scripts/test-migracion/run.sh`, comparando tamaños y tiempos de /v1/compress
  frente a producción. Trixie trae además el paquete `jbig2` (jbig2enc); no se
  ha añadido todavía (si se añade, solo sin pérdida: nunca con `-s`).
