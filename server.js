const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

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
// MÓDULO 1: CENSURA - BÚSQUEDA
// ==========================================
app.post('/v1/redact/search', upload.single('file'), (req, res) => {
    if (!req.file || !req.body.patterns) {
        return res.status(400).json({ error: 'Falta el archivo o los patrones.' });
    }

    const inputPath = req.file.path;
    const baseId = uuidv4(); // Evita colisiones de archivos temporales entre usuarios
    const patternsPath = path.join('/tmp', `patterns_${baseId}.json`);
    const resultsPath = path.join('/tmp', `results_${baseId}.json`);

    try {
        const patternsData = typeof req.body.patterns === 'string' ? req.body.patterns : JSON.stringify(req.body.patterns);
        fs.writeFileSync(patternsPath, patternsData, 'utf-8');

        const cmd = `python3 redact.py search "${inputPath}" "${patternsPath}" "${resultsPath}"`;

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error("Error en búsqueda:", stderr);
                secureCleanup([inputPath, patternsPath, resultsPath]);
                return res.status(500).json({ error: 'Error analizando el documento.' });
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
app.post('/v1/redact/apply', upload.single('file'), (req, res) => {
    if (!req.file || !req.body.items) {
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
        const cmd = `python3 redact.py apply "${inputPath}" "${outputPath}" "${itemsPath}" "${resultsPath}"`;

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error("Error en censura:", stderr);
                secureCleanup([inputPath, itemsPath, outputPath, resultsPath]);
                return res.status(500).json({ error: 'Error aplicando la censura forense.' });
            }

            // NUEVO: Leer el reporte para ver si falló alguna caja de censura específica
            let warnings = [];
            try {
                if (fs.existsSync(resultsPath)) {
                    const report = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
                    if (report.failed && report.failed.length > 0) {
                        warnings = report.failed;
                        console.warn(`[Redact] ${warnings.length} censuras no se pudieron aplicar:`, warnings);
                    }
                }
            } catch (e) {
                console.error("No se pudo leer el reporte de fallos parciales:", e);
            }

            // Si hay fallos, los inyectamos en las cabeceras HTTP
            if (warnings.length > 0) {
                res.setHeader('X-Redact-Warnings', encodeURIComponent(JSON.stringify(warnings)));
            }

            // Descarga y borrado instantáneo tras confirmar el envío
            res.sendFile(outputPath, (err) => {
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
app.post('/v1/compress', upload.single('file'), (req, res) => {
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

    const cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${pdfSettings} -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;

    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error("Error en compresión:", stderr);
            secureCleanup([inputPath, outputPath]);
            return res.status(500).json({ error: 'Fallo en el motor de compresión.' });
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
