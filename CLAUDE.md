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

# Instancia

- Render `0.5c-512mb`: 0,5 CPU y 512 MB de RAM, siempre encendida (no se
  duerme como la Free). Health Check Path: `/health`.

# Health check

- `GET /health` responde 200 `{"status":"ok"}` con `Cache-Control: no-store`.
  Es para el health check de Render (Settings → Health Check Path): va justo
  después de `cors` y antes de los parsers de body, multer y la cola HEAVY_*,
  así que no lanza gs/python ni espera en cola aunque haya trabajos pesados en
  curso. Solo dice que el proceso de Node está vivo; no comprueba que gs o
  python3 funcionen. Test en `server.test.js` (por eso `server.js` exporta
  `app` y solo llama a `listen` si se ejecuta directamente).

# Errores de subida

- El error handler de `server.js` traduce `multer.MulterError` a JSON:
  `LIMIT_FILE_SIZE` → 413 `FILE_TOO_LARGE`; cualquier otro código → 400
  `UPLOAD_ERROR` con mensaje genérico. Las cabeceras CORS llegan porque `cors`
  corre antes que las rutas, y multer borra el parcial de `pdfcadabra-uploads`
  él mismo antes de llamar al handler (verificado en local con 101 MB).

# Anonimizar (redact.py)

- Orden de `apply`: (1) reescribe los operadores `'` y `"` como `T* … Tj` en contenidos
  de página y Form XObjects; (2) aplana campos y anotaciones (`doc.bake`) y quita el
  `/AcroForm`; (3) censura con `PDF_REDACT_IMAGE_PIXELS`; (4) quita los marcadores que
  contienen un término; (5) `doc.scrub()`; (6) guarda y vuelve a buscar en la salida.
- (1) esquiva un fallo de MuPDF 1.28.2 (la última versión de PyMuPDF a 2026-10-02): su
  filtro de contenido (`apply_redactions`, `clean_contents`, `scrub` y `save(clean=True)`)
  convierte `14 TL 60 780 Td (x) '` en `60 780 TD T* (x)Tj` y saca todo el texto de la
  página. Al actualizar PyMuPDF, comprobar si sigue haciendo falta con `redact_test.py`.
- (2) va también en `search`, para que los valores de los campos salgan como hallazgos
  en el mismo sitio en que se ven.
- Verificación final (6): si un término censurado sigue en campos, anotaciones, enlaces,
  metadatos (Info y XMP), marcadores o adjuntos, o queda algún carácter dentro de una
  zona censurada, redact.py borra la salida y `server.js` responde 422
  `REDACT_NOT_VERIFIED` sin enviar nada (también si falta el informe). En el texto de
  página se mira la geometría y no el término: el usuario puede desmarcar una aparición.
  Al log solo van los sitios (`form_fields`, `outline`...), nunca los términos.
- `scrub(hidden_text=False)`: se conserva la capa de texto invisible de un OCR (si no, un
  escaneo deja de poder buscarse); bajo las zonas la borra `apply_redactions`.
- Texto conservado: se comparan las palabras (también las de la capa OCR) fuera de las zonas antes y después;
  si falta alguna, se entrega igual pero con `X-Redact-Text-Loss: [páginas]` y el
  frontend lo avisa en el panel final.
- Tamaño de salida: `apply_redactions(PDF_REDACT_IMAGE_PIXELS)` sustituye cada imagen que
  toca una zona por una copia sin comprimir (un escaneo JPEG en gris pasaba de 24 a 67 MB).
  `recompress_redacted_images` la vuelve a codificar como el original: JPEG con la calidad
  estimada de su tabla de cuantización (DQT), 1 bit en CCITT G4 sin pérdida (con comprobación de
  ida y vuelta) y JPEG 2000 en lo que ocupe menos, JPEG 85 o Flate. CMYK y el resto, sin
  pérdida (Flate). La copia se empareja con su original por ancho, alto y bits por componente
  (MuPDF cambia el xref y el nombre del recurso).
- Tests: `python -m unittest redact_test.py` (PyMuPDF real, PDFs sintéticos) y
  `redact-verify.test.js` (ruta con redact.py simulado, dentro de `npm test`).

# Pendientes

- Trixie trae el paquete `jbig2` (jbig2enc), que bookworm no tenía, por si se
  añade compresión JBIG2 sin pérdida (nunca con pérdida: sin `-s`). No añadido.
