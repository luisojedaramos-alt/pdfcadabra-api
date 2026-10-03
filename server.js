const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const uuidv4 = () => crypto.randomUUID();
const { createLimiter } = require('./limiter');
const { startPeriodicSweep } = require('./cleanup');
const { describeError, describeProcessError } = require('./errlog');

const app = express();
const port = process.env.PORT || 3000;

// 1. Configuración de middlewares y límites de carga pesada (100 MB para LexNET)
// AÑADIDO: exposedHeaders para que React pueda leer nuestras alertas de censura
// Orígenes permitidos: solo el dominio de producción (+ localhost si NODE_ENV no es 'production'),
// más los de EXTRA_ALLOWED_ORIGINS (separados por comas, p. ej. el branch deploy de dev para la
// QA). Solo se aceptan orígenes https exactos (sin ruta, comodines ni barra final); el resto se
// descarta con un aviso en el log.
const PROD_ORIGINS = ['https://pdfcadabra.com', 'https://www.pdfcadabra.com'];
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];
const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const buildAllowedOrigins = (env) => {
    const extra = [];
    for (const raw of String(env.EXTRA_ALLOWED_ORIGINS || '').split(',')) {
        const origin = raw.trim();
        if (!origin) continue;
        if (ORIGIN_RE.test(origin)) extra.push(origin);
        else console.warn(`EXTRA_ALLOWED_ORIGINS: se ignora "${origin}" (solo https://dominio, sin ruta ni barra final).`);
    }
    const base = env.NODE_ENV === 'production' ? PROD_ORIGINS : [...PROD_ORIGINS, ...DEV_ORIGINS];
    return [...new Set([...base, ...extra])];
};
const ALLOWED_ORIGINS = buildAllowedOrigins(process.env);

app.use(cors({
    origin: (origin, callback) => {
        // Sin cabecera Origin (curl, health checks, servidor-a-servidor): se permite.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            // callback(null, false) en vez de callback(new Error(...)): así el propio
            // middleware de cors rechaza la petición (sin cabeceras CORS) sin lanzar una
            // excepción hacia el error handler por defecto de Express (que exponía el
            // stack trace y rutas del sistema de archivos en la respuesta).
            callback(null, false);
        }
    },
    exposedHeaders: ['X-Redact-Warnings', 'X-Redact-Text-Loss', 'X-Compress-Status', 'X-Compress-Level']
}));

// Health check de Render: responde al instante, antes de los parsers de body y de
// multer, sin pasar por la cola pesada ni lanzar procesos hijos.
app.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// 2. Almacenamiento temporal EN DISCO (no en memoria), en una carpeta propia dentro de
// /tmp: ahí escribe multer la subida y ahí van también los JSON intermedios y el PDF de
// salida. Tener carpeta propia permite barrerla sin tocar el resto de /tmp.
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 100 * 1024 * 1024 } // Límite estricto de 100 MB
});

// ==========================================
// BORRADO DE ARCHIVOS TEMPORALES
// ==========================================
// fs.unlink normal: quita el archivo del sistema de ficheros, pero NO sobrescribe su
// contenido en disco (no es un borrado forense/seguro). Idempotente: se puede llamar
// varias veces sobre los mismos archivos.
const secureCleanup = (files) => {
    files.forEach(file => {
        if (file && fs.existsSync(file)) {
            fs.unlink(file, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error(`Error borrando rastro físico (${file}):`, describeError(err));
                }
            });
        }
    });
};

// Fallo de un proceso hijo: código de salida y el principio de su stderr, sin rutas de
// la carpeta de subidas (ver describeProcessError). '/tmp/pdfcadabra-uploads' va aparte
// por si os.tmpdir() no es /tmp.
const UPLOAD_DIRS = [...new Set([UPLOAD_DIR, '/tmp/pdfcadabra-uploads'])];
const logProcessError = (label, error, stderr) =>
    console.error(label, describeProcessError(error, stderr, UPLOAD_DIRS));

// Censuras que no se pudieron aplicar ({id, error} de redact.py): al log solo van los
// mensajes de error, sin el objeto.
const failedMessages = (failed) => failed.map((f) => String(f && f.error)).join(' | ');

// Borra una carpeta temporal con todo su contenido (la de Ghostscript de cada petición).
// Idempotente, como secureCleanup. Los borrados de una misma carpeta van en serie: se
// llama al cerrar la conexión y otra vez al acabar el envío o el proceso, y dos rm
// recursivos a la vez sobre la misma carpeta chocan (EPERM en Windows).
const tempDirRemovals = new Map();
const removeTempDir = (dir) => {
    const next = (tempDirRemovals.get(dir) || Promise.resolve())
        .then(() => fs.promises.rm(dir, { recursive: true, force: true }))
        .catch((err) => console.error(`Error borrando carpeta temporal (${dir}):`, describeError(err)))
        .finally(() => {
            if (tempDirRemovals.get(dir) === next) tempDirRemovals.delete(dir);
        });
    tempDirRemovals.set(dir, next);
};

// Red de seguridad: borra de UPLOAD_DIR lo que tenga más de 15 minutos, al arrancar y
// cada 5 minutos (archivos que quedaron si el proceso murió a mitad de una petición).
// Ninguna petición legítima dura tanto: cola máx. 90 s + máx. 180 s por proceso (por
// defecto) en Anonimizar; Comprimir encadena hasta cinco procesos (lossless_images.py, gs
// y jpeg_flate.py, más la red de seguridad), pero todos dentro de COMPRESS_TOTAL_TIMEOUT_MS.
const SWEEP_MAX_AGE_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
startPeriodicSweep(UPLOAD_DIR, SWEEP_MAX_AGE_MS, SWEEP_INTERVAL_MS);

// Equivalente a un `finally` de toda la petición: 'close' se emite una sola vez, pase
// lo que pase (envío completado, error, excepción o cliente desconectado). Un
// try/finally síncrono no serviría: se ejecutaría antes de que res.sendFile terminase
// y borraría el archivo mientras se envía. Si el cliente se va con el proceso hijo aún
// en marcha, el archivo de salida se crea después: lo borra el callback de ese proceso
// (y, en último caso, el barrido periódico).
const cleanupOnClose = (res, files) => {
    res.once('close', () => secureCleanup(files));
};

// ==========================================
// CONTROL DE CONCURRENCIA (rutas pesadas: Ghostscript / PyMuPDF)
// ==========================================
// Con poca RAM, varios procesos hijos a la vez provocan OOM. Solo corren
// HEAVY_MAX_CONCURRENT a la vez; el resto espera en cola (máx. HEAVY_MAX_QUEUE,
// máx. HEAVY_QUEUE_TIMEOUT_MS) y, si no cabe o se agota la espera, recibe un 503.
const envInt = (name, fallback) => {
    const n = parseInt(process.env[name], 10);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
};
// Tope por proceso de Anonimizar (redact.py search/apply). Comprimir usa su propio tope
// total, COMPRESS_TOTAL_TIMEOUT_MS.
const HEAVY_EXEC_TIMEOUT_MS = envInt('HEAVY_EXEC_TIMEOUT_MS', 180000);
// Tope TOTAL de /v1/compress: lossless_images.py, Ghostscript y jpeg_flate.py juntos, también los de la red de
// seguridad con el nivel low. Peor caso medido en la
// instancia 0.5c-512mb (escaneo sintético de 20 MB y 23 páginas, nivel extremo): 14,4 s de
// gs + 0,4 s de jpeg_flate.py. 90 s dejan margen para escaneos reales con muchas más
// páginas: gs escala con páginas y píxeles, no con MB.
const COMPRESS_TOTAL_TIMEOUT_MS = envInt('COMPRESS_TOTAL_TIMEOUT_MS', 90000);
// Tope de pdf_check.py verify, la comprobación del resultado antes de entregarlo (abre las dos
// versiones y mira el texto y las imágenes de cada página: segundos incluso con cientos).
const VERIFY_TIMEOUT_MS = envInt('VERIFY_TIMEOUT_MS', 30000);
const RETRY_AFTER_SECONDS = 10;
const heavyLimiter = createLimiter({
    maxConcurrent: Math.max(1, envInt('HEAVY_MAX_CONCURRENT', 1)),
    maxQueue: envInt('HEAVY_MAX_QUEUE', 5),
    queueTimeoutMs: envInt('HEAVY_QUEUE_TIMEOUT_MS', 90000)
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE_ERRORS = {
    QUEUE_FULL: 'Hay demasiadas solicitudes en curso. Inténtalo de nuevo en unos segundos.',
    QUEUE_TIMEOUT: 'Tu documento ha esperado demasiado en la cola de procesamiento. Inténtalo de nuevo.'
};

// Va DESPUÉS de multer: la petición ya está validada y su archivo en disco.
const heavyGate = async (req, res, next) => {
    // Sin archivo el handler responde 400 al instante: no merece hueco ni cola.
    if (!req.file) return next();

    const headerId = req.get('X-Request-Id');
    const id = headerId && UUID_RE.test(headerId) && !heavyLimiter.has(headerId) ? headerId : uuidv4();
    req.heavyId = id;

    // El hueco lo libera el callback del proceso hijo (runHeavy), NO el cierre de
    // la conexión: si el cliente se va con gs aún corriendo, la RAM sigue en uso.
    // Aquí solo se cubren las rutas que responden sin llegar a lanzar el proceso.
    res.on('close', () => {
        if (!req.execStarted && req.releaseSlot) req.releaseSlot();
        // Cliente desconectado mientras esperaba en cola: fuera de la cola y borrar su subida.
        if (!res.writableFinished && heavyLimiter.cancel(id)) secureCleanup([req.file.path]);
    });

    try {
        req.releaseSlot = await heavyLimiter.acquire(id);
    } catch (err) {
        if (err.code === 'CANCELLED') return; // cliente ya desconectado; el borrado lo hizo el 'close'
        secureCleanup([req.file.path]);
        if (QUEUE_ERRORS[err.code]) {
            res.set('Retry-After', String(RETRY_AFTER_SECONDS));
            return res.status(503).json({ code: err.code, error: QUEUE_ERRORS[err.code] });
        }
        console.error('Error inesperado en la cola de procesamiento:', describeError(err));
        return res.status(500).json({ error: 'Error del servidor en la cola de procesamiento.' });
    }
    next();
};

// Lanza el proceso hijo con timeout y libera el hueco al terminar (éxito, error o timeout).
// keepSlot: si el proceso termina bien, el hueco sigue ocupado para el siguiente paso de
// la misma petición, que es quien lo libera (release es idempotente).
const runHeavy = (req, command, args, callback, { keepSlot = false, timeoutMs = HEAVY_EXEC_TIMEOUT_MS, env } = {}) => {
    const options = { timeout: timeoutMs, killSignal: 'SIGKILL' };
    if (env) options.env = env;
    const child = execFile(command, args, options, (error, stdout, stderr) => {
        if ((!keepSlot || error) && req.releaseSlot) req.releaseSlot();
        callback(error, stdout, stderr);
    });
    req.execStarted = true; // tras execFile: si este lanzase una excepción, el 'close' aún libera el hueco
    return child;
};

// Proceso matado por su timeout (runHeavy lo lanza con killSignal SIGKILL).
const isExecTimeout = (error) => error.killed && error.signal === 'SIGKILL';

// PDF con contraseña de apertura: lossless_images.py y redact.py salen con este
// código (pdf_check.EXIT_ENCRYPTED) sin procesar nada. Los de solo contraseña de propietario se
// abren con la contraseña vacía y se procesan como cualquier otro.
const EXIT_ENCRYPTED = 3;
const isEncryptedExit = (error) => !!error && error.code === EXIT_ENCRYPTED && !isExecTimeout(error);
const sendEncrypted = (res) => res.status(422).json({
    code: 'PDF_ENCRYPTED',
    error: 'Este PDF está protegido con contraseña. Quítala primero con Desbloquear PDF y vuelve a intentarlo.'
});

// 504 si el proceso superó su tope de tiempo; 422 si el PDF tiene contraseña de apertura; si
// no, el 500 propio de cada ruta.
const sendExecError = (res, error, fallbackMessage) => {
    if (isEncryptedExit(error)) return sendEncrypted(res);
    if (isExecTimeout(error)) {
        return res.status(504).json({ code: 'PROCESSING_TIMEOUT', error: 'El documento ha tardado demasiado en procesarse.' });
    }
    return res.status(500).json({ error: fallbackMessage });
};

// Estado de una petición pesada, para que el frontend avise al usuario mientras
// espera. El cliente genera un UUID y lo envía en X-Request-Id al hacer el POST;
// con ese mismo UUID consulta aquí. No pasa por la cola y solo revela el estado.
//   { state: 'queued', position: 2 } | { state: 'running' } | { state: 'unknown' }
app.get('/v1/queue/status/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(heavyLimiter.getStatus(req.params.id));
});

// ==========================================
// MÓDULO 1: CENSURA - BÚSQUEDA
// ==========================================
app.post('/v1/redact/search', upload.single('file'), heavyGate, (req, res) => {
    if (!req.file || !req.body.patterns) {
        secureCleanup([req.file && req.file.path]); // multer ya guardó la subida: no dejarla en /tmp
        return res.status(400).json({ error: 'Falta el archivo o los patrones.' });
    }

    const inputPath = req.file.path;
    const baseId = uuidv4(); // Evita colisiones de archivos temporales entre usuarios
    const patternsPath = path.join(UPLOAD_DIR, `patterns_${baseId}.json`);
    const resultsPath = path.join(UPLOAD_DIR, `results_${baseId}.json`);

    try {
        const patternsData = typeof req.body.patterns === 'string' ? req.body.patterns : JSON.stringify(req.body.patterns);
        fs.writeFileSync(patternsPath, patternsData, 'utf-8');

        runHeavy(req, 'python3', ['redact.py', 'search', inputPath, patternsPath, resultsPath], (error, stdout, stderr) => {
            if (error) {
                if (isEncryptedExit(error)) console.warn('[Redact] PDF con contraseña de apertura: 422 sin procesar.');
                else logProcessError("Error en búsqueda:", error, stderr);
                secureCleanup([inputPath, patternsPath, resultsPath]);
                return sendExecError(res, error, 'Error analizando el documento.');
            }

            try {
                const resultsData = fs.readFileSync(resultsPath, 'utf-8');
                res.json(JSON.parse(resultsData));
            } catch (parseError) {
                res.status(500).json({ error: 'Error procesando los hallazgos.' });
            } finally {
                secureCleanup([inputPath, patternsPath, resultsPath]);
            }
        });
    } catch (e) {
        secureCleanup([inputPath, patternsPath, resultsPath]);
        res.status(500).json({ error: 'Error del servidor preparando la búsqueda.' });
    }
});

// ==========================================
// MÓDULO 2: CENSURA - DESTRUCCIÓN Y APLICACIÓN
// ==========================================
app.post('/v1/redact/apply', upload.single('file'), heavyGate, (req, res) => {
    if (!req.file || !req.body.items) {
        secureCleanup([req.file && req.file.path]); // multer ya guardó la subida: no dejarla en /tmp
        return res.status(400).json({ error: 'Falta el archivo o los hallazgos.' });
    }

    const inputPath = req.file.path;
    const baseId = uuidv4();
    const itemsPath = path.join(UPLOAD_DIR, `items_${baseId}.json`);
    const outputPath = path.join(UPLOAD_DIR, `censored_${baseId}.pdf`);
    const resultsPath = path.join(UPLOAD_DIR, `redact_results_${baseId}.json`); // NUEVO: Archivo de reporte
    cleanupOnClose(res, [inputPath, itemsPath, outputPath, resultsPath]);

    try {
        const itemsData = typeof req.body.items === 'string' ? req.body.items : JSON.stringify(req.body.items);
        fs.writeFileSync(itemsPath, itemsData, 'utf-8');

        // NUEVO: Se añade el quinto argumento (resultsPath) al comando Python
        runHeavy(req, 'python3', ['redact.py', 'apply', inputPath, outputPath, itemsPath, resultsPath], (error, stdout, stderr) => {
            if (error) {
                if (isEncryptedExit(error)) console.warn('[Redact] PDF con contraseña de apertura: 422 sin procesar.');
                else logProcessError("Error en censura:", error, stderr);
                secureCleanup([inputPath, itemsPath, outputPath, resultsPath]);
                return sendExecError(res, error, 'Error aplicando la censura forense.');
            }

            // NUEVO: Leer el reporte para ver si falló alguna caja de censura específica
            let report = null;
            try {
                if (fs.existsSync(resultsPath)) {
                    report = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
                }
            } catch (e) {
                console.error("No se pudo leer el reporte de fallos parciales:", describeError(e));
            }

            // CRÍTICO: redact.py vuelve a buscar en el PDF censurado (texto de página, campos,
            // anotaciones, metadatos, XMP, marcadores y adjuntos). Sin informe o sin
            // verified === true no se envía nada: un fallo aquí nunca entrega el documento.
            if (!report || report.verified !== true) {
                const leaks = (report && Array.isArray(report.leaks)) ? report.leaks.join(', ') : 'sin informe';
                console.error(`[Redact] Verificación final fallida (${leaks}): no se envía el documento.`);
                secureCleanup([inputPath, itemsPath, outputPath, resultsPath]);
                return res.status(422).json({
                    code: 'REDACT_NOT_VERIFIED',
                    error: 'No hemos podido garantizar la censura de este documento; no se ha descargado nada.'
                });
            }

            const failed = report.failed || [];
            const applied = report.applied || 0;
            const totalRequested = applied + failed.length;

            // CRÍTICO: si se pidieron censuras y NINGUNA se aplicó, el PDF de salida
            // es idéntico al original sin censurar. Nunca lo enviamos como si fuera un éxito.
            if (totalRequested > 0 && applied === 0) {
                console.error(`[Redact] Fallaron todas las censuras (${failed.length}/${totalRequested}):`, failedMessages(failed));
                secureCleanup([inputPath, itemsPath, outputPath, resultsPath]);
                return res.status(422).json({
                    error: 'No se pudo aplicar ninguna censura. El documento no se ha modificado y no ha sido enviado.',
                    failed
                });
            }

            // Si hay fallos parciales, los inyectamos en las cabeceras HTTP
            if (failed.length > 0) {
                console.warn(`[Redact] ${failed.length} censuras no se pudieron aplicar:`, failedMessages(failed));
                res.setHeader('X-Redact-Warnings', encodeURIComponent(JSON.stringify(failed)));
            }

            // Páginas (desde 1) que han perdido texto fuera de las zonas censuradas: el
            // documento se entrega, pero el frontend lo avisa en el panel final.
            const textLoss = Array.isArray(report.text_loss_pages) ? report.text_loss_pages : [];
            if (textLoss.length > 0) {
                console.warn(`[Redact] Texto perdido fuera de las zonas censuradas en ${textLoss.length} página(s).`);
                res.setHeader('X-Redact-Text-Loss', JSON.stringify(textLoss));
            }

            // Envío del resultado y borrado de los temporales al terminar el envío (con
            // éxito o con error; no hay confirmación de que el navegador lo guardase)
            res.sendFile(outputPath, (err) => {
                if (err && !res.headersSent) {
                    console.error("Error enviando el documento censurado:", describeError(err));
                    res.status(500).json({ error: 'Error enviando el documento censurado.' });
                }
                secureCleanup([inputPath, itemsPath, outputPath, resultsPath]);
            });
        });
    } catch (e) {
        secureCleanup([inputPath, itemsPath, outputPath, resultsPath]);
        res.status(500).json({ error: 'Error del servidor preparando la censura.' });
    }
});

// ==========================================
// MÓDULO 3: COMPRESIÓN AVANZADA (Ghostscript)
// ==========================================
// Ahorro mínimo (2 %) para devolver un resultado en vez del original.
const MIN_COMPRESS_SAVING = 0.02;

// Niveles de compresión: preset de Ghostscript + resolución objetivo (ppp) de las
// imágenes en color/gris (null = no se reducen) + calidad
// JPEG con la que se recodifican las de color/gris (QFactor de Ghostscript; calibrado
// con gs 10: QFactor = (100 − calidad IJG) / 50, así que 0,7 ≈ calidad 65 y 0,8 ≈ 60).
// Calibrado (2026-10) frente a iLovePDF con un escaneo real en gris de 51 páginas a 300 ppp:
// su recomendada es 150 ppp y ~q60, su extrema 72 ppp y ~q65.
// extreme: máximo ahorro · recommended: equilibrio entre peso y legibilidad · low: sin reducir
const COMPRESS_LEVELS = {
    extreme: { pdfSettings: '/screen', colorDpi: 100, jpegQFactor: 0.8 },
    recommended: { pdfSettings: '/ebook', colorDpi: 150, jpegQFactor: 0.7 },
    low: { pdfSettings: '/printer', colorDpi: null, jpegQFactor: null }
};

// Parámetros de reducción de un tipo de imagen ('Color', 'Gray' o 'Mono') para Ghostscript.
const downsampleArgs = (kind, dpi, threshold) =>
    dpi === null
        ? [`-dDownsample${kind}Images=false`]
        : [`-dDownsample${kind}Images=true`, `-d${kind}ImageResolution=${dpi}`, `-d${kind}ImageDownsampleThreshold=${threshold}`];

// Argumentos de Ghostscript para un nivel. Se exporta para medir en local con el mismo
// comando exacto que usa el servidor.
//
// Color y gris (recomendada y extrema): umbral 1.0, así que se reduce todo lo que pase de
// la resolución objetivo, y siempre a JPEG con la calidad del nivel. Método /Bicubic en todos
// los niveles: los presets /screen, /ebook y /printer usan /Average (media de bloques), que
// suaviza menos y deja más detalle fino (ruido del papel) que el JPEG paga en bytes. Sin forzar JPEG,
// Ghostscript elegía Flate (sin pérdida) para muchas fotos: en un expediente unido de 155
// páginas la salida pesaba un 61 % MÁS que la entrada, y codificar en Flate era además lo
// más lento (130 s frente a 55 s con 0,5 CPU). PassThroughJPEGImages=false: los JPEG que no
// se reducen también se recodifican con la calidad del nivel.
// Blanco y negro, Indexed de hasta 16 colores y demás imágenes de pocos colores (códigos
// de barras, QR del CSV, sellos): nunca pasan por Ghostscript, lossless_images.py las
// sustituye antes por marcadores (ImageMask de 64x2) y jpeg_flate.py vuelve a poner las
// originales. Por eso B/N no se reduce nunca (un marcador reducido ya no se reconocería;
// además, las de 1 bit no deben bajar de 300 ppp) y MaxInlineImageSize=0: sin él,
// pdfwrite mete las imágenes pequeñas, también los marcadores, dentro del contenido de la
// página. Lo que quede en B/N (imágenes en línea del original) sale en CCITT G4, sin pérdida.
// Baja: sin reducir ni recodificar imágenes (solo reescritura, fuentes y deduplicación).
const compressArgs = ({ pdfSettings, colorDpi, jpegQFactor }, inputPath, outputPath) => {
    const jpeg = jpegQFactor !== null;
    const imageDict = `<< /QFactor ${jpegQFactor} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
    return [
        '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', `-dPDFSETTINGS=${pdfSettings}`,
        ...downsampleArgs('Color', colorDpi, 1.0),
        ...downsampleArgs('Gray', colorDpi, 1.0),
        '-dColorImageDownsampleType=/Bicubic', '-dGrayImageDownsampleType=/Bicubic',
        ...(jpeg ? [
            '-dAutoFilterColorImages=false', '-dColorImageFilter=/DCTEncode',
            '-dAutoFilterGrayImages=false', '-dGrayImageFilter=/DCTEncode',
            '-dPassThroughJPEGImages=false'
        ] : []),
        '-dDownsampleMonoImages=false', '-dMonoImageFilter=/CCITTFaxEncode',
        '-dMaxInlineImageSize=0',
        '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${outputPath}`,
        // La calidad JPEG solo se puede fijar con setdistillerparams (después del preset).
        ...(jpeg ? ['-c', `<< /ColorImageDict ${imageDict} /GrayImageDict ${imageDict} >> setdistillerparams`, '-f'] : []),
        inputPath
    ];
};

app.post('/v1/compress', upload.single('file'), heavyGate, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No se ha subido ningún archivo.' });
    }

    const inputPath = req.file.path;
    // hasOwn: `level` viene del cliente; evita claves heredadas como "constructor".
    const level = Object.hasOwn(COMPRESS_LEVELS, req.body.level) ? req.body.level : 'recommended';
    // Intermedio (salida de Ghostscript) y salida final (tras jpeg_flate.py) de la pasada
    // del nivel pedido y, si hace falta, de la red de seguridad con el nivel low.
    const passPaths = (tag) => ({ gs: `${inputPath}_${tag}_gs.pdf`, out: `${inputPath}_${tag}.pdf` });
    const primaryPaths = passPaths('compressed');
    const fallbackPaths = passPaths('fallback');
    // Entrada para Ghostscript con las imágenes protegidas sustituidas por marcadores.
    const protectedPath = `${inputPath}_protected.pdf`;
    // ¿Hay imágenes protegidas? Si las hay, Ghostscript lee protectedPath y la salida de gs
    // no vale sin jpeg_flate.py (lleva marcadores en lugar de esas imágenes).
    let hasProtected = false;
    const tempFiles = [inputPath, protectedPath, primaryPaths.gs, primaryPaths.out, fallbackPaths.gs, fallbackPaths.out];
    // Carpeta temporal propia de Ghostscript (TMPDIR en Linux, TEMP/TMP en Windows): sus
    // archivos de trabajo (gs_*) no quedan sueltos en /tmp si se le mata por el tope de
    // tiempo. Se borra con el resto de temporales y, en último caso, con el barrido.
    const gsTmpDir = path.join(UPLOAD_DIR, `gs-${uuidv4()}`);
    const cleanupAll = () => {
        secureCleanup(tempFiles);
        removeTempDir(gsTmpDir);
    };
    res.once('close', cleanupAll);
    try {
        fs.mkdirSync(gsTmpDir);
    } catch (e) {
        console.error('Error creando la carpeta temporal de Ghostscript:', describeError(e));
        cleanupAll();
        return res.status(500).json({ error: 'Fallo en el motor de compresión.' });
    }
    const gsEnv = { ...process.env, TMPDIR: gsTmpDir, TEMP: gsTmpDir, TMP: gsTmpDir };

    // Todos los procesos (gs y jpeg_flate.py, también los de la red de seguridad) comparten
    // un único tope: cada uno solo tiene lo que sobre. El hueco de la cola se mantiene hasta
    // la respuesta (keepSlot) y se libera al enviarla (release es idempotente).
    const deadline = Date.now() + COMPRESS_TOTAL_TIMEOUT_MS;
    const remaining = () => deadline - Date.now();
    const releaseSlot = () => {
        if (req.releaseSlot) req.releaseSlot();
    };

    // Una pasada: Ghostscript y después jpeg_flate.py. done(fallo, rutaDelResultado).
    function runPass(conf, { gs: gsPath, out: outPath }, done) {
        const gsInput = hasProtected ? protectedPath : inputPath;
        runHeavy(req, 'gs', compressArgs(conf, gsInput, gsPath), (error, stdout, stderr) => {
            if (error) return done({ error, stderr, label: 'Error en compresión:' });
            if (remaining() <= 0) {
                if (hasProtected) {
                    return done({ error: Object.assign(new Error('Tope de compresión agotado'), { killed: true, signal: 'SIGKILL' }) });
                }
                console.warn('Tope de compresión agotado tras Ghostscript; se usa su salida sin jpeg_flate.py.');
                return done(null, gsPath);
            }
            // Ghostscript quita la capa Flate a los JPEG que la llevaban: jpeg_flate.py la
            // restaura (sin pérdida) cuando reduce su tamaño. Con --originals vuelve a poner
            // las imágenes protegidas.
            const postArgs = ['jpeg_flate.py', gsPath, outPath, ...(hasProtected ? ['--originals', inputPath] : [])];
            try {
                runHeavy(req, 'python3', postArgs, (error, stdout, stderr) => {
                    // Tope agotado en jpeg_flate.py: la salida de gs ya es un PDF válido, solo le
                    // falta restaurar la capa Flate de algunos JPEG. Mejor eso que un error.
                    // Salvo con imágenes protegidas: sin restaurar, la salida lleva marcadores.
                    if (error && isExecTimeout(error) && !hasProtected) {
                        console.warn('Tope de compresión agotado en jpeg_flate.py; se usa la salida de Ghostscript.');
                        return done(null, gsPath);
                    }
                    if (error) return done({ error, stderr, label: 'Error en el paso posterior de la compresión:' });
                    done(null, outPath);
                }, { keepSlot: true, timeoutMs: remaining() });
            } catch (e) {
                console.error('Error lanzando el paso posterior de la compresión:', describeError(e));
                done({ error: e });
            }
        }, { keepSlot: true, timeoutMs: Math.max(1, remaining()), env: gsEnv });
    }

    // ¿Ahorra al menos MIN_COMPRESS_SAVING frente al original? null si no se puede leer.
    function savesEnough(resultPath) {
        try {
            return fs.statSync(resultPath).size <= fs.statSync(inputPath).size * (1 - MIN_COMPRESS_SAVING);
        } catch (statError) {
            console.error('Error leyendo el resultado de la compresión:', describeError(statError));
            return null;
        }
    }

    function fail({ error, stderr, label }) {
        releaseSlot();
        if (isEncryptedExit(error)) console.warn('[Compress] PDF con contraseña de apertura: 422 sin procesar.');
        else if (label) logProcessError(label, error, stderr);
        cleanupAll();
        return sendExecError(res, error, 'Fallo en el motor de compresión.');
    }

    function statFailed() {
        releaseSlot();
        cleanupAll();
        return res.status(500).json({ error: 'Fallo en el motor de compresión.' });
    }

    // X-Compress-Status: 'compressed', o 'already-optimized' si se devuelve el original
    // porque nada lo redujo al menos un MIN_COMPRESS_SAVING (el valor se mantiene por
    // compatibilidad con el frontend). X-Compress-Level: nivel aplicado de verdad
    // ('extreme', 'recommended', 'low', o 'none' si se devuelve el original).
    function send(resultPath, appliedLevel) {
        releaseSlot();
        const compressed = resultPath !== null;
        res.setHeader('X-Compress-Status', compressed ? 'compressed' : 'already-optimized');
        res.setHeader('X-Compress-Level', compressed ? appliedLevel : 'none');
        // El archivo de multer no tiene extensión: sin esto se enviaría como octet-stream.
        res.type('application/pdf');
        // Envío del resultado y borrado de los temporales al terminar el envío (con
        // éxito o con error; no hay confirmación de que el navegador lo guardase)
        res.sendFile(compressed ? resultPath : inputPath, () => cleanupAll());
    }

    // Antes de Ghostscript, una sola vez para las dos pasadas: lossless_images.py sustituye
    // las imágenes que no admiten pérdida por marcadores y dice cuántas (0 = no escribe nada).
    function protectImages(done) {
        try {
            runHeavy(req, 'python3', ['lossless_images.py', 'protect', inputPath, protectedPath], (error, stdout, stderr) => {
                if (error) return done({ error, stderr, label: 'Error preparando la compresión:' });
                hasProtected = Number.parseInt(String(stdout).trim(), 10) > 0;
                done(null);
            }, { keepSlot: true, timeoutMs: Math.max(1, remaining()) });
        } catch (e) {
            console.error('Error lanzando la preparación de la compresión:', describeError(e));
            done({ error: e });
        }
    }

    // Red de seguridad antes de entregar cualquier resultado: pdf_check.py comprueba que se abre
    // sin errores, que tiene las mismas páginas que la entrada y que ninguna página con contenido
    // ha quedado vacía. Si no, se devuelve el original sin tocar: un documento vacío o
    // incompleto nunca sale del servidor. Tiene su propio tope (no cuenta contra el de la
    // compresión: el resultado ya existe y solo falta comprobarlo).
    function verifiedSend(resultPath, appliedLevel) {
        try {
            // Cualquier fallo de verify (salida no válida, excepción, tope de tiempo o python que
            // muere) acaba igual: el original sin tocar. Nunca un 500 ni la salida sin verificar.
            runHeavy(req, 'python3', ['pdf_check.py', 'verify', inputPath, resultPath], (error, stdout, stderr) => {
                if (!error) return send(resultPath, appliedLevel);
                logProcessError('[Compress] Resultado no válido; se devuelve el original:', error, stderr);
                send(null);
            }, { keepSlot: true, timeoutMs: VERIFY_TIMEOUT_MS });
        } catch (e) {
            console.error('Error lanzando la comprobación del resultado:', describeError(e));
            send(null);
        }
    }

    function compressAll() {
        runPass(COMPRESS_LEVELS[level], primaryPaths, (err, resultPath) => {
            if (err) return fail(err);
            const ok = savesEnough(resultPath);
            if (ok === null) return statFailed();
            if (ok) return verifiedSend(resultPath, level);
            // Red de seguridad: si recomendada o extrema no reducen, se intenta con la lógica
            // de low (reescritura, fuentes y deduplicación, sin tocar imágenes) dentro del
            // mismo tope antes de devolver el original.
            if (level === 'low' || remaining() <= 0) return send(null);
            console.warn(`Compresión ${level} sin ahorro suficiente; se reintenta con el nivel low.`);
            runPass(COMPRESS_LEVELS.low, fallbackPaths, (fallbackErr, fallbackPath) => {
                // Si la red de seguridad falla o se queda sin tiempo, el original sigue siendo
                // una respuesta válida: no se convierte en error.
                if (fallbackErr) {
                    if (fallbackErr.label) {
                        const label = fallbackErr.label.replace(/:$/, ' (red de seguridad, nivel low):');
                        logProcessError(label, fallbackErr.error, fallbackErr.stderr);
                    }
                    return send(null);
                }
                const fallbackOk = savesEnough(fallbackPath);
                if (fallbackOk === null) return statFailed();
                if (fallbackOk) return verifiedSend(fallbackPath, 'low');
                send(null);
            });
        });
    }

    protectImages((protectErr) => (protectErr ? fail(protectErr) : compressAll()));
});

// Manejo de errores no gestionados: debe ir el último y tener 4 argumentos para que
// Express lo reconozca como error handler. Nunca expone el stack trace ni rutas del
// sistema de archivos al cliente, ni en desarrollo ni en producción; el detalle solo
// va al log del servidor.
app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }
    // Errores de la subida (multer). Las cabeceras CORS ya están puestas: el
    // middleware de cors corre antes que las rutas. multer borra por su cuenta lo
    // que llegase a escribir en UPLOAD_DIR antes de pasar el error.
    if (err instanceof multer.MulterError) {
        console.warn(`Subida rechazada (${err.code}${err.field ? `, campo "${err.field}"` : ''})`);
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'FILE_TOO_LARGE', message: 'El archivo supera el máximo de 100 MB.' });
        }
        return res.status(400).json({ error: 'UPLOAD_ERROR', message: 'No se ha podido procesar el archivo subido.' });
    }
    console.error('Error no gestionado:', describeError(err));
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: 'Solicitud no permitida' });
});

// Iniciar servidor (solo al ejecutarlo con `node server.js`; los tests importan `app`)
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Servidor PDFcadabra LegalTech activo en puerto ${port}`);
    });
}

module.exports = app;
// Para medir en local con el mismo comando de Ghostscript que el servidor.
module.exports.compressArgs = compressArgs;
module.exports.COMPRESS_LEVELS = COMPRESS_LEVELS;
module.exports.buildAllowedOrigins = buildAllowedOrigins;
