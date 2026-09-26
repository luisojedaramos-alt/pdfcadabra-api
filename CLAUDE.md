# Notas de proceso

- Si al trabajar en una tarea encuentras un problema adicional no relacionado
  con lo que se te pidió (por ejemplo, otra vulnerabilidad reportada por
  `npm audit` distinta a la que estabas arreglando), resuélvelo en un commit
  separado del commit de la tarea original, y dilo explícitamente en tu
  resumen final (qué encontraste, en qué commit quedó). No lo mezcles en el
  mismo commit aunque el arreglo sea pequeño.

# Imagen

- **Hecho (2026-09-26): la imagen usa `node:24-trixie-slim`** (antes
  `node:20-bookworm-slim`; Node 20 llegó a fin de vida el 2026-04-30). Node 24
  tiene soporte hasta el 2028-04-30 (fuente: `nodejs/Release`, schedule.json):
  planificar la siguiente migración antes de esa fecha. Trixie trae
  Ghostscript 10.05.1, Python 3.13 (PyMuPDF 1.28.2 desde la rueda abi3 en el
  venv) y poppler-utils 25.03 (el código no lo usa). Validado antes de fusionar
  en un servicio temporal de Render con `scripts/test-migracion/run.sh`:
  tamaños de /v1/compress a menos de un 1 % de los de bookworm (265 bytes más
  por archivo, de metadatos), mismos tiempos y mismo resultado en Anonimizar.
  El script sirve para repetir la comparación en futuras migraciones.

# Errores de subida

- El error handler de `server.js` traduce `multer.MulterError` a JSON:
  `LIMIT_FILE_SIZE` → 413 `FILE_TOO_LARGE`; cualquier otro código → 400
  `UPLOAD_ERROR` con mensaje genérico. Las cabeceras CORS llegan porque `cors`
  corre antes que las rutas, y multer borra el parcial de `pdfcadabra-uploads`
  él mismo antes de llamar al handler (verificado en local con 101 MB).

# Pendientes

- Trixie trae el paquete `jbig2` (jbig2enc), que bookworm no tenía, por si se
  añade compresión JBIG2 sin pérdida (nunca con pérdida: sin `-s`). No añadido.
