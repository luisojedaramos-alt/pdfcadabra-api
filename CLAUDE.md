# Notas de proceso

- Si al trabajar en una tarea encuentras un problema adicional no relacionado
  con lo que se te pidió (por ejemplo, otra vulnerabilidad reportada por
  `npm audit` distinta a la que estabas arreglando), resuélvelo en un commit
  separado del commit de la tarea original, y dilo explícitamente en tu
  resumen final (qué encontraste, en qué commit quedó). No lo mezcles en el
  mismo commit aunque el arreglo sea pequeño.

# Pendientes

- **Migrar el Dockerfile fuera de Node 20 (EOL).** `FROM node:20-bookworm-slim`
  usa una versión que llegó a fin de vida el 2026-04-30 (última release:
  20.20.2, 2026-03-24), así que ya no recibe parches de seguridad. Fuentes:
  calendario oficial `nodejs/Release` (schedule.json) y endoflife.date.
  Candidatos: Node 22 (EOL 2027-04-30) o Node 24 (EOL 2028-04-30). Requiere una
  investigación propia antes de tocarlo: compatibilidad de multer 2.x,
  PyMuPDF y el resto del stack con la nueva versión. Tarea aparte, no mezclar
  con otros cambios.
