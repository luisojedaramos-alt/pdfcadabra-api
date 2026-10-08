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

- Desde el 2026-10-03, VPS de Clouding (Ubuntu 24.04, 4 vCPU, 8 GB de RAM, sin
  swap) en vez de Render. Docker Compose (`deploy/docker-compose.yml`, ver
  `deploy/README.md`): la API y Caddy delante (HTTPS de `api.pdfcadabra.com`,
  cuerpo máx. 110 MB). No hay `.env`: todo va en el compose.
- Contenedor de la API: `mem_limit` 6 GiB, `/tmp` en tmpfs de 3 GiB (cuenta
  dentro de los 6), `pids_limit` 512, sin límite de CPU. `NODE_ENV=production`,
  `HEAVY_MAX_CONCURRENT=3`, `HEAVY_MAX_QUEUE=8`. Topes de tiempo, los del código:
  cola 90 s, Comprimir 90 s en total (+30 s de verificación), Anonimizar 180 s
  por proceso. Health check de Docker a `/health` cada 30 s.
- Comprobado en el servidor el 2026-10-08 (`docker inspect` del contenedor,
  revisión 5ba1c90).

# Health check

- `GET /health` responde 200 `{"status":"ok"}` con `Cache-Control: no-store`.
  Es para el health check de Render (Settings → Health Check Path): va justo
  después de `cors` y antes de multer y la cola HEAVY_*,
  así que no lanza gs/python ni espera en cola aunque haya trabajos pesados en
  curso. Solo dice que el proceso de Node está vivo; no comprueba que gs o
  python3 funcionen. Test en `server.test.js` (por eso `server.js` exporta
  `app` y solo llama a `listen` si se ejecuta directamente).
- No hay `express.json` ni `express.urlencoded` (desde 2026-10-08): ninguna ruta
  los usaba y leían en memoria cuerpos de hasta 100 MB en cualquier ruta (20 de
  94 MB subían el contenedor +2,2 GB y bloqueaban el bucle). Test en
  `body-parsers.test.js`.

# Errores de subida

- El error handler de `server.js` traduce `multer.MulterError` a JSON:
  `LIMIT_FILE_SIZE` → 413 `FILE_TOO_LARGE`; cualquier otro código → 400
  `UPLOAD_ERROR` con mensaje genérico. Las cabeceras CORS llegan porque `cors`
  corre antes que las rutas, y multer borra el parcial de `pdfcadabra-uploads`
  él mismo antes de llamar al handler (verificado en local con 101 MB).

# Anonimizar (redact.py)

- Orden de `apply`: (1) reescribe los operadores `'` y `"` como `T* … Tj` en contenidos
  de página y Form XObjects; (2) aplana campos y anotaciones (`doc.bake`) y quita el
  `/AcroForm`; (3) censura con `PDF_REDACT_IMAGE_PIXELS` y `PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED`; (4) quita los marcadores que
  contienen un término; (5) `doc.scrub()`; (6) guarda y vuelve a buscar en la salida.
- (1) se hace sobre el contenido de la página ya unido (el operando de un `'` puede estar en un
  flujo de `/Contents` y el operador en el siguiente; si alguno cruza, la página pasa a un único
  flujo). Si un contenido con `'` o `"` no se puede analizar, no se censura: 422
  `REDACT_NOT_VERIFIED` (`leaks: ["content_syntax"]`).
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
  página visible se mira la geometría y no el término: el usuario puede desmarcar una
  aparición visible. Decisión de Luis (2026-10-07): el texto oculto (fuera del CropBox o del
  MediaBox, desplazado fuera de la página o en una capa OCG apagada) nunca puede contener un
  término, sin contar apariciones (`hidden_text`): se extrae con clip infinito y sin
  `/OCProperties` (copia `<salida>.capas.pdf`, que se borra al terminar) y se descuentan las
  palabras visibles. Además, barrido de todos los objetos descomprimidos (`pdf_objects`):
  cadenas literales y hex (PDFDocEncoding, UTF-8, UTF-16 con o sin BOM) de cada objeto y el
  contenido de los flujos, sin contar guiones ni espacios. No lee contenidos (página, Form,
  patrones, glifos Type3), fuentes ni sus CMaps, ni imágenes y perfiles ICC (binarios: un
  término corto saldría por azar). Coste medido con 300 págs: barrido 0,04 s, texto oculto
  1,2 s. Al log solo van los sitios (`form_fields`, `outline`...), nunca los términos.
- Texto oculto en `apply` (decisión de Luis, 2026-10-07, fase 2): las palabras ocultas que
  forman un término se censuran solas, porque el usuario no las ve. Se buscan antes de
  censurar (`hidden_term_rects`, igual que la verificación) y se borran en una pasada aparte
  solo de texto: sin relleno, sin tocar imágenes ni trazos (un fondo que sale del CropBox se
  ve). Esas zonas no van a `zones_by_page`: si se llevaran texto visible, lo avisa
  `X-Redact-Text-Loss`. Las palabras llegan sin girar: la zona visible es
  `page.rect * derotation_matrix`. Con capas OCG, las palabras de todas las capas salen de
  una copia en disco (`<salida>.pre.pdf` y su `.capas.pdf`, borradas al terminar), así que
  también se censura el texto de las capas apagadas.
- Nombres de capa (`clean_layer_names`, tras `scrub`): una capa cuyo `/Name` contiene un
  término pasa a llamarse "Capa N"; cualquier otra cadena con un término en
  `/OCProperties` (nombre de configuración, etiquetas de `/Order`, `/Usage`) se vacía.
  Mismo criterio que el barrido final (`term_matcher`).
- Estructuras con texto libre (`clean_structures`, tras `scrub`, mismo criterio): marcador con
  URI o destino con nombre con un término -> destino explícito a su página, o sin destino si
  era una URI (el título ya lo mira `remove_outline_terms`); `/Names /Dests` -> fuera esas
  entradas (el árbol se reescribe plano); `/OpenAction` y cada entrada de `/AA` con un término
  -> fuera; `/PieceInfo` con un término -> fuera; `/Alt`, `/ActualText`, `/T` y `/E` con un
  término -> cadena vacía; prefijo de `/PageLabels` -> vacío; `/I` de un `/Threads` -> fuera.
- Censuras fallidas (`failed` del informe, p. ej. página inexistente): si falla CUALQUIERA,
  `server.js` responde 422 `REDACT_ITEMS_FAILED` con la lista y no envía nada (desde
  2026-10-07; antes, con fallos parciales, se enviaba con `X-Redact-Warnings`, que ya no se usa).
  `item_zone` da por fallida la censura con página negativa o inexistente y con un
  rectángulo invertido, vacío o que no toca la página (MuPDF los aceptaba sin tapar nada).
  Los rectángulos llegan sin girar, como los da `search_for`: se comparan con
  `page.rect * page.derotation_matrix`. Uno que sale en parte de la página sí vale.
- Trazos (decisión de Luis, 2026-10-07): `REMOVE_IF_TOUCHED` quita entero todo trazo que
  toque una zona (antes, `REMOVE_IF_COVERED`, una firma que entraba y salía quedaba bajo el
  negro). Se aceptan las líneas de tabla que rocen la zona. Un relleno con patrón que la zona
  toque desaparece entero; el texto que perdiera lo avisa `X-Redact-Text-Loss`.
- Rellenos lisos (decisión de Luis, 2026-10-07): `solid_fills_touching` guarda antes de
  censurar los rectángulos de un solo color sin trazo que tocan una zona (fondo de página,
  celdas), recortados por su recorte si es rectangular; `restore_fills` repinta debajo de todo
  (`overlay=False`) los que `apply_redactions` ha quitado. No se guardan los que están bajo un
  recorte no rectangular o en un grupo transparente, ni los que tapaban algo dibujado antes
  (orden de `get_bboxlog`, cuyo índice es el `seqno` de `get_drawings`): repintados debajo,
  destaparían lo que ocultaban.
- Censura falsa (decisión de Luis, 2026-10-07): un relleno liso que tapaba algo dibujado antes
  se repinta ENCIMA de todo, en su sitio, con su color y su opacidad, y sobre él otra vez el
  negro de las zonas que toca: el documento nunca queda menos tapado que el original, aunque
  así tape también lo que se le dibujaba encima. El orden de dibujo sale de
  `_content_bboxlog` (solo el contenido: `get_bboxlog` incluye la anotación de censura ya
  puesta). Solo rectángulos lisos: una firma o un sello rellenos que tapan texto se quitan.
- Adjuntos por `/AF` (PDF/A-3, Factur-X): tras `scrub`, `remove_associated_files` quita la
  clave `/AF` de todos los objetos, igual que `scrub(embedded_files=True)` vacía el árbol de
  nombres; el Filespec y su flujo quedan huérfanos y `save(garbage=4)` los elimina.
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

# PDF con contraseña (pdf_check.py)

- Caso a), contraseña de apertura: `/v1/compress`, `/v1/redact/search` y `/v1/redact/apply`
  responden 422 `{code: "PDF_ENCRYPTED"}` sin procesar nada. Lo detecta el primer script de
  cada ruta (`lossless_images.py protect` en Comprimir, `redact.py` en Anonimizar) con
  `pdf_check.needs_password` y sale con el código 3 (`EXIT_ENCRYPTED`), que `server.js`
  traduce a 422. Antes Comprimir daba 200 con el original o con una página en blanco
  (Ghostscript sale con 0 ante "This file requires a password") y Anonimizar un 500 genérico.
- Caso b), solo contraseña de propietario (habitual en sedes judiciales): PyMuPDF lo abre con
  la contraseña vacía y se procesa como cualquier otro; la salida va sin cifrar.
- El frontend ya los rechaza en el navegador antes de subirlos; el 422 es la red de seguridad.
- Red de seguridad de Comprimir: antes de entregar cualquier resultado (de cualquier nivel o de
  la red de seguridad del nivel low), `pdf_check.py verify <entrada> <salida>` comprueba que se
  abre sin errores, que tiene las mismas páginas que la entrada y que ninguna página con
  contenido (texto o imágenes) ha quedado vacía. Si no, se devuelve el original sin tocar
  (`X-Compress-Status: already-optimized`) y el motivo va al log. Tope propio:
  `VERIFY_TIMEOUT_MS` (30 s), fuera del de la compresión.
- Tests: `python -m unittest pdf_check_test.py` y `pdf-encrypted.test.js` (servidor real con
  python3, PyMuPDF y gs; se salta si faltan; en Windows `PYTHON=python` y `GS=<gswin64c.exe>`).

# Pendientes

- Trixie trae el paquete `jbig2` (jbig2enc), que bookworm no tenía, por si se
  añade compresión JBIG2 sin pérdida (nunca con pérdida: sin `-s`). No añadido.
