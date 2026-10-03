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
  (MuPDF cambia el xref y el nombre del recurso) y, si varias coinciden, por su posición en la
  página (por orden, un QR podía tomar la calidad JPEG de una foto del mismo tamaño). Una copia
  con 16 colores o menos nunca pasa a JPEG. MuPDF convierte las Indexed censuradas a RGB de 8
  bits: quedan en Flate, sin pérdida.
- Tests: `python -m unittest redact_test.py` (PyMuPDF real, PDFs sintéticos) y
  `redact-verify.test.js` (ruta con redact.py simulado, dentro de `npm test`).

# Comprimir: imágenes sin pérdida (lossless_images.py)

- Regla: las imágenes de 1 bit (DeviceGray, ICCBased, Indexed de 2 colores, ImageMask, JBIG2...),
  las Indexed de hasta 16 colores y las de 8 bits sin JPEG con hasta 16 colores (QR o sello
  insertados desde PNG) salen SIN PÉRDIDA y SIN REDUCIR en todos los niveles. Suelen ser el
  código de barras o el QR del CSV, que debe seguir siendo escaneable. Ghostscript no lo
  respeta por sí solo: pasaba una barra de 1 bit en ICCBased a JPEG RGB a la mitad de ppp.
- Cómo: `lossless_images.py protect` sustituye cada una por un marcador (ImageMask de 64x2 con
  su número de objeto) antes de gs; `jpeg_flate.py --originals <subida>` pone después la
  original con su flujo comprimido tal cual (las de 1 bit en Flate pasan a CCITT G4 si ocupa
  menos) y falla si queda algún marcador, también dentro de un contenido. Por eso gs va con
  `-dMaxInlineImageSize=0` (si no, mete los marcadores en el contenido) y sin reducir B/N.
  Con marcadores, la salida de gs nunca se envía sin restaurar: si el tope se agota antes, 504.
- Decisión de Luis (2026-10-03): la regla se aplica completa, también a las máscaras de texto
  de página completa de los escaneos (ImageMask de 1 bit), aunque pesen más. Motivo: los
  escaneos judiciales llevan el código CSV (barras o QR) dentro de esa misma imagen de página,
  así que reducirla o pasarla a JPEG puede dejarlo ilegible. No proteger solo las imágenes
  pequeñas para recuperar tamaño.
- Coste medido (2026-10-03, gs 10.08 local): escaneo gris 51 págs igual; expediente 155 págs
  recomendada 1,80 -> 2,17 MB y extrema 1,17 -> 1,55 MB (las máscaras de texto CCITT ya no
  bajan a 150 ppp); escaneo color 23 págs extrema 0,78 -> 1,42 MB por lo mismo.
- Tests: `python -m unittest lossless_images_test.py` (gs real con los argumentos de server.js:
  píxeles idénticos y QR/Code128 decodificables en los tres niveles). Generar y decodificar los
  códigos necesita `pip install -r requirements-test.txt` (zxing-cpp y Pillow, solo para tests,
  no van en la imagen); sin ellos esas pruebas se saltan con un aviso.

# Pendientes

- Trixie trae el paquete `jbig2` (jbig2enc), que bookworm no tenía, por si se
  añade compresión JBIG2 sin pérdida (nunca con pérdida: sin `-s`). No añadido.
