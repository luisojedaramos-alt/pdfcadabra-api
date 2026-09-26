# Notas de proceso

- Si al trabajar en una tarea encuentras un problema adicional no relacionado
  con lo que se te pidió (por ejemplo, otra vulnerabilidad reportada por
  `npm audit` distinta a la que estabas arreglando), resuélvelo en un commit
  separado del commit de la tarea original, y dilo explícitamente en tu
  resumen final (qué encontraste, en qué commit quedó). No lo mezcles en el
  mismo commit aunque el arreglo sea pequeño.

# Pendientes

- **PRIORITARIO: migrar la imagen a una versión de Node con soporte sobre
  Debian trixie.** `FROM node:20-bookworm-slim` usa una versión que llegó a fin
  de vida el 2026-04-30 (última release: 20.20.2, 2026-03-24), así que ya no
  recibe parches de seguridad. Fuentes: calendario oficial `nodejs/Release`
  (schedule.json) y endoflife.date. Candidatos: `node:22-trixie-slim` (EOL
  2027-04-30) o `node:24-trixie-slim` (EOL 2028-04-30). Trixie además trae el
  paquete `jbig2` (jbig2enc), que bookworm no tiene, por si se añade compresión
  JBIG2 sin pérdida (nunca con pérdida: sin `-s`). Antes de cambiarlo, comprobar
  multer 2.x, PyMuPDF (pip en el venv), Ghostscript y poppler-utils de trixie
  con la nueva versión, y repetir las mediciones de /v1/compress (las
  resoluciones de Ghostscript pueden variar entre versiones). Commit propio, no
  mezclar con otros cambios.
