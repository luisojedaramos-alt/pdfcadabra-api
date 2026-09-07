const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Permitir que la web de Lovable se conecte
app.use(cors());

// Carpeta temporal en la memoria RAM del servidor
const upload = multer({ dest: '/tmp/' });

app.post('/v1/compress', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const outputPath = path.join('/tmp', `comprimido_${Date.now()}.pdf`);

    // Traducir el nivel de Lovable a la potencia de Ghostscript
    let gsQuality = '/ebook'; // recommended (buena calidad, peso bajo)
    if (req.body.level === 'extreme') gsQuality = '/screen'; // calidad baja, peso pluma
    if (req.body.level === 'low') gsQuality = '/printer'; // alta calidad

    // Comando industrial idéntico al de iLovePDF
    const gsCommand = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${gsQuality} -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${outputPath} ${inputPath}`;

    exec(gsCommand, (error) => {
        if (error) {
            console.error('Error procesando:', error);
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            return res.status(500).send('Error interno de compresión');
        }

        // Devolver el archivo procesado al abogado
        res.download(outputPath, 'pdfcadabra-pro.pdf', () => {
            // DESTRUCCIÓN INMEDIATA: Garantía de secreto profesional
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        });
    });
});

app.listen(port, () => console.log(`Motor PDFcadabra escuchando en el puerto ${port}`));
