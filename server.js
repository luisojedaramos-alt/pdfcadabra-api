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

const app = express();
const port = process.env.PORT || 3000;

// 1. Configuración de middlewares y límites de carga pesada (100 MB para LexNET)
// AÑADIDO: exposedHeaders para que React pueda leer nuestras alertas de censura
// Orígenes permitidos: solo el dominio de producción (+ localhost si NODE_ENV no es 'production').
const PROD_ORIGINS = ['https://pdfcadabra.com', 'https://www.pdfcadabra.com'];
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];
const ALLOWED_ORIGINS =
    process.env.NODE_ENV === 'production' ? PROD_ORIGINS : [...PROD_ORIGINS, ...DEV_ORIGINS];

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
    exposedHeaders: ['X-Redact-Warnings', 'X-Compress-Status']
}));
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
                    console.error(`Error borrando rastro físico (${file}):`, err);
                }
            });
        }
    });
};

// Red de seguridad: borra de UPLOAD_DIR lo que tenga más de 15 minutos, al arrancar y
// cada 5 minutos (archivos que quedaron si el proceso murió a mitad de una petición).
// Ninguna petición legítima dura tanto: cola máx. 90 s + máx. 180 s por proceso (por
// defecto), y la ruta más larga (compresión) encadena dos procesos: 7,5 min en total.
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
// 180 s: un PDF de 20 MB (máximo del plan gratuito) en nivel extremo tarda unos 110 s
// en Ghostscript en Render (~6,7 veces más lento que un equipo de sobremesa).
const HEAVY_EXEC_TIMEOUT_MS = envInt('HEAVY_EXEC_TIMEOUT_MS', 180000);
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
        console.error('Error inesperado en la cola de procesamiento:', err);
        return res.status(500).json({ error: 'Error del servidor en la cola de procesamiento.' });
    }
    next();
};

// Lanza el proceso hijo con timeout y libera el hueco al terminar (éxito, error o timeout).
// keepSlot: si el proceso termina bien, el hueco sigue ocupado para el siguiente paso de
// la misma petición, que es quien lo libera (release es idempotente).
const runHeavy = (req, command, args, callback, { keepSlot = false } = {}) => {
    const child = execFile(command, args, { timeout: HEAVY_EXEC_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if ((!keepSlot || error) && req.releaseSlot) req.releaseSlot();
        callback(error, stdout, stderr);
    });
    req.execStarted = true; // tras execFile: si este lanzase una excepción, el 'close' aún libera el hueco
    return child;
};

// 504 si el proceso superó HEAVY_EXEC_TIMEOUT_MS; si no, el 500 propio de cada ruta.
const sendExecError = (res, error, fallbackMessage) => {
    if (error.killed && error.signal === 'SIGKILL') {
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
                console.error("Error en búsqueda:", stderr);
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
                console.error("Error en censura:", stderr);
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
                console.error("No se pudo leer el reporte de fallos parciales:", e);
            }

            const failed = (report && report.failed) || [];
            const applied = report ? report.applied : 0;
            const totalRequested = applied + failed.length;

            // CRÍTICO: si se pidieron censuras y NINGUNA se aplicó, el PDF de salida
            // es idéntico al original sin censurar. Nunca lo enviamos como si fuera un éxito.
            if (totalRequested > 0 && applied === 0) {
                console.error(`[Redact] Fallaron todas las censuras (${failed.length}/${totalRequested}):`, failed);
                secureCleanup([inputPath, itemsPath, outputPath, resultsPath]);
                return res.status(422).json({
                    error: 'No se pudo aplicar ninguna censura. El documento no se ha modificado y no ha sido enviado.',
                    failed
                });
            }

            // Si hay fallos parciales, los inyectamos en las cabeceras HTTP
            if (failed.length > 0) {
                console.warn(`[Redact] ${failed.length} censuras no se pudieron aplicar:`, failed);
                res.setHeader('X-Redact-Warnings', encodeURIComponent(JSON.stringify(failed)));
            }

            // Envío del resultado y borrado de los temporales al terminar el envío (con
            // éxito o con error; no hay confirmación de que el navegador lo guardase)
            res.sendFile(outputPath, (err) => {
                if (err && !res.headersSent) {
                    console.error("Error enviando el documento censurado:", err);
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
// Ahorro mínimo (2 %) para devolver la salida de Ghostscript en vez del original.
const MIN_COMPRESS_SAVING = 0.02;

// Niveles de compresión: preset de Ghostscript + resolución objetivo (ppp) de las
// imágenes en color/gris y de las de blanco y negro (null = no se reducen).
// El color/gris usa umbral 1.5: solo se reduce lo que supere 1,5 × el objetivo
// (~225 ppp en recomendada, ~165 en extrema). Así los fondos JPEG de 150 ppp de los
// escaneos no se recodifican (es lo que más tiempo cuesta y apenas ahorra), pero las
// fotos de alta resolución (informes periciales, fotos de daños) sí se reducen.
// extreme: máximo ahorro · recommended: balance ideal LexNET · low: sin reducir nada
const COMPRESS_LEVELS = {
    extreme: { pdfSettings: '/screen', colorDpi: 110, monoDpi: 150 },
    recommended: { pdfSettings: '/ebook', colorDpi: 150, monoDpi: 200 },
    low: { pdfSettings: '/printer', colorDpi: null, monoDpi: null }
};

// Parámetros de reducción de un tipo de imagen ('Color', 'Gray' o 'Mono') para Ghostscript.
const downsampleArgs = (kind, dpi, threshold) =>
    dpi === null
        ? [`-dDownsample${kind}Images=false`]
        : [`-dDownsample${kind}Images=true`, `-d${kind}ImageResolution=${dpi}`, `-d${kind}ImageDownsampleThreshold=${threshold}`];

app.post('/v1/compress', upload.single('file'), heavyGate, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No se ha subido ningún archivo.' });
    }

    const inputPath = req.file.path;
    const level = req.body.level || 'recommended';
    const gsOutputPath = `${inputPath}_gs.pdf`; // intermedio: salida de Ghostscript
    const outputPath = `${inputPath}_compressed.pdf`; // salida final, tras jpeg_flate.py
    const tempFiles = [inputPath, gsOutputPath, outputPath];
    cleanupOnClose(res, tempFiles);

    // hasOwn: `level` viene del cliente; evita claves heredadas como "constructor".
    const { pdfSettings, colorDpi, monoDpi } =
        Object.hasOwn(COMPRESS_LEVELS, level) ? COMPRESS_LEVELS[level] : COMPRESS_LEVELS.recommended;

    const args = [
        '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', `-dPDFSETTINGS=${pdfSettings}`,
        // Resoluciones explícitas: los presets nunca reducen las imágenes en blanco y
        // negro (CCITT), que en los escaneos de juzgado suponen la mayor parte del peso.
        ...downsampleArgs('Color', colorDpi, 1.5),
        ...downsampleArgs('Gray', colorDpi, 1.5),
        // B/N: umbral 1.0 (el mínimo), porque con el 1.5 por defecto 300 ppp no llega a
        // bajar a 200. /Subsample es el único método que Ghostscript admite para B/N.
        ...downsampleArgs('Mono', monoDpi, 1.0), '-dMonoImageDownsampleType=/Subsample',
        '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${gsOutputPath}`, inputPath
    ];

    runHeavy(req, 'gs', args, (error, stdout, stderr) => {
        if (error) {
            console.error("Error en compresión:", stderr);
            secureCleanup(tempFiles);
            return sendExecError(res, error, 'Fallo en el motor de compresión.');
        }

        // Ghostscript quita la capa Flate a los JPEG que la llevaban: jpeg_flate.py la
        // restaura (sin pérdida) cuando reduce su tamaño. Usa el mismo hueco de la cola.
        try {
            runHeavy(req, 'python3', ['jpeg_flate.py', gsOutputPath, outputPath], sendCompressed);
        } catch (e) {
            if (req.releaseSlot) req.releaseSlot();
            console.error("Error lanzando el paso posterior de la compresión:", e);
            secureCleanup(tempFiles);
            res.status(500).json({ error: 'Fallo en el motor de compresión.' });
        }
    }, { keepSlot: true });

    function sendCompressed(error, stdout, stderr) {
        if (error) {
            console.error("Error en el paso posterior de la compresión:", stderr);
            secureCleanup(tempFiles);
            return sendExecError(res, error, 'Fallo en el motor de compresión.');
        }

        // El resultado puede pesar más que el original (p. ej. si ya estaba optimizado).
        // Si el tamaño final no ahorra al menos MIN_COMPRESS_SAVING, devolvemos el
        // original tal cual y lo indicamos en X-Compress-Status.
        let inputSize, outputSize;
        try {
            inputSize = fs.statSync(inputPath).size;
            outputSize = fs.statSync(outputPath).size;
        } catch (statError) {
            console.error("Error leyendo el resultado de la compresión:", statError);
            secureCleanup(tempFiles);
            return res.status(500).json({ error: 'Fallo en el motor de compresión.' });
        }
        const compressed = outputSize <= inputSize * (1 - MIN_COMPRESS_SAVING);
        res.setHeader('X-Compress-Status', compressed ? 'compressed' : 'already-optimized');
        // El archivo de multer no tiene extensión: sin esto se enviaría como octet-stream.
        res.type('application/pdf');

        // Envío del resultado y borrado de los temporales al terminar el envío (con
        // éxito o con error; no hay confirmación de que el navegador lo guardase)
        res.sendFile(compressed ? outputPath : inputPath, (err) => {
            secureCleanup(tempFiles);
        });
    }
});

// Manejo de errores no gestionados: debe ir el último y tener 4 argumentos para que
// Express lo reconozca como error handler. Nunca expone el stack trace ni rutas del
// sistema de archivos al cliente, ni en desarrollo ni en producción; el detalle solo
// va al log del servidor.
app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }
    console.error('Error no gestionado:', err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: 'Solicitud no permitida' });
});

// Iniciar servidor
app.listen(port, () => {
    console.log(`Servidor PDFcadabra LegalTech activo en puerto ${port}`);
});
