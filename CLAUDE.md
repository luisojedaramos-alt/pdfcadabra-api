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
  cuerpo máx. 26 MB). No hay `.env`: todo va en el compose.
- Contenedor de la API: `mem_limit` 6 GiB, `/tmp` en tmpfs de 3 GiB (cuenta
  dentro de los 6), `pids_limit` 512, sin límite de CPU. `NODE_ENV=production`,
  `HEAVY_MAX_CONCURRENT=3`, `HEAVY_MAX_QUEUE=8`. Topes de tiempo, los del código
  (ver Límites por plan): cola 180 s, Comprimir 180 s en total (+30 s de
  verificación), Anonimizar 240 s por proceso. Health check de Docker a `/health`
  cada 30 s.
- Comprobado en el servidor el 2026-10-08 (`docker inspect` del contenedor,
  revisión 5ba1c90). Revisión actual en producción: a9f24d1 (desplegada el
  2026-10-14).

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
  él mismo antes de llamar al handler (verificado en local con 101 MB; hoy el
  límite es de 50 MB, ver Límites por plan).
- Subida cortada por el cliente (multer pasa "Request aborted"/"Request closed" o el
  error del socket): si el cuerpo está incompleto y el socket cerrado, solo un aviso
  `Subida cortada por el cliente.` y ninguna respuesta. Cualquier otro error, también de
  multer con la conexión abierta, sigue saliendo como `Error no gestionado`. Test en
  `upload-aborted.test.js`.

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
  insertados desde PNG; también las Indexed con hival de 16 o más que solo usan hasta 16
  índices, contados sin decodificar a RGB, desde 2026-10-10: antes se reducían y en extrema un
  QR de módulos de 2 px dejaba de leerse) salen SIN PÉRDIDA y SIN REDUCIR en todos los
  niveles. Suelen ser el código de barras o el QR del CSV, que debe seguir siendo escaneable.
  Ghostscript no lo respeta por sí solo: pasaba una barra de 1 bit en ICCBased a JPEG RGB a la mitad de ppp.
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

# Protección de la API (rama feat/proteccion-api, 2026-10-08)

- Cliente desconectado sin respuesta (`res` 'close' sin `writableFinished`): `abortHeavy`
  mata con SIGKILL los procesos hijos en marcha de la petición (gs, python), libera el hueco
  y marca la petición: `runHeavy` ya no lanza el siguiente paso (jpeg_flate.py, la red de
  seguridad, verify) ni llama a su callback. Los borrados de cada ruta (`cleanupOnClose`) se
  repiten cuando muere el proceso: con SIGKILL, redact.py no borra sus copias de capas
  (`<salida>.capas.pdf`, `.pre.pdf`, `.pre.pdf.capas.pdf`). Ningún script lanza
  subprocesos, así que no quedan nietos huérfanos. Medido antes: gs seguía 16 s y
  redact.py 52 s tras el corte, ocupando su hueco. Test en `disconnect.test.js`
  (procesos reales que no terminan).
- Cola llena antes del cuerpo (`admitUpload`, antes de multer en las tres rutas POST): si
  las subidas en curso más los huecos ocupados y las peticiones en cola (`heavyLimiter.load()`;
  una grande cuenta por dos huecos y, con alguien en cola, los huecos libres cuentan como
  ocupados, desde 2026-10-14: antes contaba peticiones y con una grande en marcha admitía una
  subida de más que recibía el 503 tras subir el archivo entero)
  llegan a `capacity` (HEAVY_MAX_CONCURRENT + HEAVY_MAX_QUEUE, 11 en el servidor), 503
  `QUEUE_FULL` con `Retry-After: 10` y `Connection: close` sin leer el cuerpo. La subida
  deja de contar al entrar en heavyGate (pasa a contar en el limiter) o al cerrarse.
  Medido antes: cada 503 llegaba tras recibir el archivo entero, y unas 35 subidas de
  90 MB llenaban el tmpfs (ENOSPC, 500 genérico). Test en `admission.test.js`.
- Límite de subida (50 MB gratis, 100 MB Pro; ver Límites por plan; 20 MB hasta el
  2026-10-13). `checkUploadSize`, lo primero de cada ruta POST, responde 413
  `FILE_TOO_LARGE` sin leer el cuerpo si el Content-Length pasa del límite más 5 MB de
  margen del multipart (4 campos de 1 MB como mucho, `MAX_FIELDS`/`MAX_FIELD_BYTES`, más
  cabeceras); el límite exacto del archivo lo aplica multer, también sin Content-Length.
  El cuerpo del 413 sigue siendo `{error: "FILE_TOO_LARGE", message}`. Caddy corta en
  134 MB (100 del plan Pro + 33 de margen de `/v1/redact/apply`, para no tener que tocarlo
  al activar Pro): el 413 del plan gratuito lo da siempre la API. Test en
  `upload-limit.test.js`.
- Lista de hallazgos (`items`) de `/v1/redact/apply` (desde 2026-10-14): campo de texto de
  hasta 16 MB (`ITEMS_MAX_BYTES`; antes 1 MB, como el resto). Con 50 MB salen decenas de
  miles: 16.822 en un vectorial de 30 MB, unos 330 bytes cada uno tal como los da search
  (5,5 MB), y 16 MB son unos 50.000. Por encima, 413 `{error: "ITEMS_TOO_LARGE", message}`
  sin dejar archivos. Solo esa ruta: `APPLY_FIELDS` (2 campos de 16 MB + 1 byte: busboy da
  el campo por truncado al llegar a `fieldSize`), y su margen en `checkUploadSize` es
  2 × 16 MB + 1 MB = 33 MB; las demás siguen con `FIELDS` (4 de 1 MB, margen 5 MB).
  Decisión: campo de texto y no parte de archivo. busboy aplica el tope mientras lee, y
  con un archivo el `fileSize` de multer es uno para todas las partes (una lista de 50 MB
  llegaría a /tmp antes de poder rechazarla). Cuesta memoria: como mucho 16 MB por
  petición, 176 MB con las 11 admitidas a la vez. Test en `redact-items.test.js`
  (20.000 hallazgos).
- Límite por cliente (`iplimit.js`, `limitPerClient`, tras `checkUploadSize` y antes de
  `admitUpload`): 3 peticiones a la vez por IP, contando la subida (`IP_MAX_CONCURRENT`), y
  60 cada 10 min (`IP_MAX_PER_WINDOW`, `IP_WINDOW_MS`, ventana fija); si no, 429
  `RATE_LIMITED` con `Retry-After` y sin leer el cuerpo. Cuentan también las que luego
  rechaza la cola. La clave es un HMAC de la IP con una clave aleatoria de cada arranque,
  en un `Map` que se purga al caducar la ventana: ninguna IP en memoria, disco ni log.
  `trust proxy` = 1: comprobado el 2026-10-08 en el servidor de pruebas (Caddy 2.11.4 por
  HTTP, misma config) que un `X-Forwarded-For` falsificado (una o varias entradas,
  cabecera repetida, `X-Real-IP`, `Forwarded`) no cambia `req.ip`: Caddy lo sustituye por
  la IP real. Solo se podría falsificar hablando directamente con el puerto 3000, que no se
  publica. Si algún día la API se expone sin Caddy, revisar esto. Test en `iplimit.test.js`.
- Origin obligatorio (`requireOrigin`, lo primero de las tres rutas POST): sin un Origin de
  `ALLOWED_ORIGINS`, 403 `ORIGIN_NOT_ALLOWED` sin leer el cuerpo. Antes `cors` solo omitía
  sus cabeceras y la petición se procesaba igual. Solo frena el uso casual (curl puede
  poner cualquier Origin). `/health`, `/v1/queue/status` y el preflight no lo exigen.
  `deploy/bench.sh` y `scripts/test-migracion/run.sh` envían `ORIGIN` (por defecto
  https://pdfcadabra.com), y los tests de la API también. Test en `origin.test.js`.
- `Retry-After` va en `exposedHeaders` de CORS (desde 2026-10-10), para que el frontend lo
  lea: 10 s en el 503 `QUEUE_FULL`/`QUEUE_TIMEOUT` y en el 429 por simultáneas, y lo que
  queda de la ventana (redondeado arriba, mínimo 1) en el 429 por ventana agotada. Test en
  `retry-after.test.js`.
- Orden en cada ruta POST: `requireOrigin` (403) → `checkUploadSize` (413) →
  `limitPerClient` (429) → `admitUpload` (503) → multer → `heavyGate` (cola).

# Límites por plan (rama feat/limites-50-100, 2026-10-13)

- Decisión de Luis (2026-10-13, según la medición del lote 1b: unos 2,8 s/MB al comprimir
  escaneos en recomendada o extrema y unos 2 s/MB por proceso al anonimizar): gratis 50 MB,
  Pro 100 MB, 200 MB no. `PLAN_LIMITS` en `server.js`:
  gratis 50 MB, Comprimir 180 s en total, Anonimizar 240 s por proceso (decisión de Luis,
  2026-10-14, tras medir apply al 77-85 % de los 180 s iniciales); Pro 100 MB, 330 s y 240 s. Variables de entorno: `COMPRESS_TOTAL_TIMEOUT_MS` y `HEAVY_EXEC_TIMEOUT_MS`
  (gratis, las de siempre), `PRO_COMPRESS_TOTAL_TIMEOUT_MS` y `PRO_HEAVY_EXEC_TIMEOUT_MS`.
  Espera máxima en cola (`HEAVY_QUEUE_TIMEOUT_MS`): 180 s, para todos.
- Pro no tiene cuentas: `app.locals.planFor(req)` devuelve siempre `'free'` y es donde
  entrará la cuenta (cualquier valor que no sea `'pro'` cuenta como gratis). Los tests lo
  sustituyen para probar el camino Pro.
- Peso: un PDF de más de 50 MB (`LARGE_JOB_BYTES`, el límite gratis; hoy solo Pro) ocupa 2
  de los huecos de `HEAVY_MAX_CONCURRENT` (`limiter.acquire(id, peso)`; nunca más que
  `maxConcurrent`). Con 3 huecos: uno grande y uno normal a la vez. La cola es FIFO estricta:
  si el primero no cabe, los de detrás esperan aunque quepan (si no, el grande podía esperar
  para siempre). `limiter.js` ya no usa p-limit. Tests en `limiter.test.js` y
  `plan-limits.test.js` (topes de cada plan, peso y QUEUE_TIMEOUT de 180 s con
  temporizadores simulados).
- /tmp (tmpfs de 3 GiB) en el peor caso, con `HEAVY_MAX_CONCURRENT=3` y `HEAVY_MAX_QUEUE=8`
  (`admitUpload` limita subidas + cola + en marcha a 11 archivos): un trabajo de Comprimir
  guarda a la vez la subida, la copia con marcadores, la salida de gs y la de jpeg_flate.py y,
  con la red de seguridad, otras dos: hasta 6 veces el archivo; Anonimizar (apply), la
  entrada, la salida y hasta tres copias de capas: 5 veces. Gratis: 3 × 300 + 8 × 50 =
  1,3 GB; Pro: 1 grande (600) + 1 normal (300) + 8 × 100 = 1,7 GB. Cabe en 3 GiB: se dejan
  `HEAVY_MAX_QUEUE` y el tmpfs como estaban. Medido en local (2026-10-13): escaneo de 50 MB
  en recomendada, 104 MB en /tmp; vectorial de 51 MB en low, 87 MB; Anonimizar el vectorial
  (apply), 90 MB, y con una capa OCG, 195 MB.
- Anonimizar un vectorial de 51 MB (medido en local el 2026-10-13, 2.600 págs., 27.530
  hallazgos, 10 por página): search 66-70 s y apply 138-152 s, verificado (58-63 % del tope
  de 240 s; el servidor puede ser más lento que el PC). Con
  hallazgos en todas las líneas (144 por página, 374.000), search tardó 919 s y dejó un JSON
  de 120 MB: ningún tope razonable lo cubre (504).
- Timeouts que podrían cortar antes que los topes (revisado el 2026-10-13): Caddy no tiene
  ninguno por defecto para el cuerpo ni la respuesta (solo 1 min para las cabeceras); Node
  (`requestTimeout`) solo cuenta mientras se recibe la petición (comprobado: una respuesta
  lenta tras una subida rápida no lo dispara). Decisión de Luis (2026-10-14): 600 s en vez de
  los 300 de Node, así que subir 100 MB exige ~1,4 Mbit/s y 50 MB ~0,7. Va en las opciones
  de `http.createServer` (`startServer`): asignarlo tras `listen` no se aplicaba. Las
  cabeceras siguen con 60 s. multer no tiene tope de tiempo. El barrido de /tmp
  (15 min) queda por encima de lo más largo que dura una petición tras la subida (540 s en Pro).
  El frontend tiene sus propios topes (Comprimir 240 s en total, Anonimizar 120 s por
  petición): hay que subirlos allí.
