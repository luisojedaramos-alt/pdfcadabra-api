const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
const upload = multer({ dest: '/tmp/' });

app.post('/v1/compress', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const outputPath = path.join('/tmp', `comprimido_${Date.now()}.pdf`);

    // Traducir el nivel a DPIs estrictos para forzar la reducción de píxeles
    let dpi = 144; // Recomendada (equivalente al 60-65% de ahorro de iLovePDF)
    if (req.body.level === 'extreme') dpi = 72; // Extrema
    if (req.body.level === 'low') dpi = 200; // Baja

    // Comando industrial agresivo: fuerza el remuestreo de TODAS las imágenes a JPEG
    const gsCommand = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dDownsampleColorImages=true -dColorImageResolution=${dpi} -dDownsampleGrayImages=true -dGrayImageResolution=${dpi} -dDownsampleMonoImages=true -dMonoImageResolution=${dpi} -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode -dAutoFilterGrayImages=false -dGrayImageFilter=/DCTEncode -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${outputPath} ${inputPath}`;

    exec(gsCommand, (error) => {
        if (error) {
            console.error('Error procesando:', error);
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            return res.status(500).send('Error interno de compresión');
        }

        res.download(outputPath, 'pdfcadabra-pro.pdf', () => {
            // Destrucción inmediata
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        });
    });
});

app.listen(port, () => console.log(`Motor PDFcadabra escuchando en el puerto ${port}`));
