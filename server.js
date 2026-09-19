const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { createLimiter } = require('./limiter');

const app = express();
const port = process.env.PORT || 3000;

// 1. Configuración de middlewares y límites de carga pesada (100 MB para LexNET)
// AÑADIDO: exposedHeaders para que React pueda leer nuestras alertas de censura
app.use(cors({
    exposedHeaders: ['X-Redact-Warnings']
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// 2. Almacenamiento efímero en memoria (/tmp)
const upload = multer({
    dest: '/tmp/',
    limits: { fileSize: 100 * 1024 * 1024 } // Límite estricto de 100 MB
});

// ==========================================
// FUNCIÓN CRÍTICA: LIMPIEZA FORENSE DE DISCO
// ==========================================
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
const HEAVY_EXEC_TIMEOUT_MS = envInt('HEAVY_EXEC_TIMEOUT_MS', 120000);
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
const runHeavy = (req, command, args, callback) => {
    const child = execFile(command, args, { timeout: HEAVY_EXEC_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (req.releaseSlot) req.releaseSlot();
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
    const patternsPath = path.join('/tmp', `patterns_${baseId}.json`);
    const resultsPath = path.join('/tmp', `results_${baseId}.json`);

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
    const itemsPath = path.join('/tmp', `items_${baseId}.json`);
    const outputPath = path.join('/tmp', `censored_${baseId}.pdf`);
    const resultsPath = path.join('/tmp', `redact_results_${baseId}.json`); // NUEVO: Archivo de reporte

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

            // Descarga y borrado instantáneo tras confirmar el envío
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
app.post('/v1/compress', upload.single('file'), heavyGate, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No se ha subido ningún archivo.' });
    }

    const inputPath = req.file.path;
    const level = req.body.level || 'recommended';
    const outputPath = `${inputPath}_compressed.pdf`;

    // Mapeo de niveles para el motor de compresión
    // extreme: calidad pantalla baja (máximo ahorro)
    // recommended: calidad ebook (balance ideal LexNET)
    // low: calidad impresión (retiene detalle fotográfico)
    let pdfSettings = '/ebook';
    if (level === 'extreme') pdfSettings = '/screen';
    if (level === 'low') pdfSettings = '/printer';

    const args = [
        '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', `-dPDFSETTINGS=${pdfSettings}`,
        '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${outputPath}`, inputPath
    ];

    runHeavy(req, 'gs', args, (error, stdout, stderr) => {
        if (error) {
            console.error("Error en compresión:", stderr);
            secureCleanup([inputPath, outputPath]);
            return sendExecError(res, error, 'Fallo en el motor de compresión.');
        }

        // Descarga y borrado instantáneo tras confirmar el envío
        res.sendFile(outputPath, (err) => {
            secureCleanup([inputPath, outputPath]);
        });
    });
});

// Iniciar servidor
app.listen(port, () => {
    console.log(`Servidor PDFcadabra LegalTech activo en puerto ${port}`);
});
