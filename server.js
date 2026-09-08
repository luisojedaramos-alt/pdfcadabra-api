const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Configurar CORS para permitir peticiones desde tu web
app.use(cors());

// Carpeta temporal en la memoria RAM del servidor
const upload = multer({ dest: '/tmp/' });

// ==========================================
// 1. MOTOR DE COMPRESIÓN (Ya lo teníamos)
// ==========================================
app.post('/v1/compress', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const outputPath = path.join('/tmp', `comprimido_${Date.now()}.pdf`);

    let dpi = 144;
    if (req.body.level === 'extreme') dpi = 72;
    if (req.body.level === 'low') dpi = 200;

    const gsCommand = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dDownsampleColorImages=true -dColorImageResolution=${dpi} -dDownsampleGrayImages=true -dGrayImageResolution=${dpi} -dDownsampleMonoImages=true -dMonoImageResolution=${dpi} -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode -dAutoFilterGrayImages=false -dGrayImageFilter=/DCTEncode -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${outputPath} "${inputPath}"`;

    exec(gsCommand, (error) => {
        if (error) {
            console.error('Error procesando:', error);
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            return res.status(500).send('Error de compresión');
        }

        res.download(outputPath, 'pdfcadabra-pro.pdf', () => {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        });
    });
});

// ==========================================
// 2. MOTOR DE MINIATURAS (¡NUEVO!)
// ==========================================
app.post('/v1/thumbnails', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    
    const inputPath = req.file.path;
    const outputPrefix = path.join('/tmp', `thumb_${Date.now()}`);

    // pdftoppm: Comando industrial para convertir PDFs a JPG a altísima velocidad
    // -jpeg: Formato salida | -scale-to 400: Ancho de 400px (ideal para miniaturas UI)
    const cmd = `pdftoppm -jpeg -scale-to 400 "${inputPath}" "${outputPrefix}"`;

    exec(cmd, (error) => {
        if (error) {
            console.error('Error generando miniaturas:', error);
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            return res.status(500).send('Fallo en el motor gráfico');
        }

        try {
            // Leer todos los archivos JPG generados (thumb_123-1.jpg, thumb_123-2.jpg...)
            const prefixBase = path.basename(outputPrefix);
            const files = fs.readdirSync('/tmp/').filter(f => f.startsWith(prefixBase));
            
            // Ordenar correctamente por número de página
            files.sort((a, b) => {
                const numA = parseInt(a.match(/-(\d+)\.jpg$/)[1]);
                const numB = parseInt(b.match(/-(\d+)\.jpg$/)[1]);
                return numA - numB;
            });

            // Convertir las imágenes a Base64 para enviarlas a la web en un solo paquete
            const base64Images = files.map(file => {
                const filePath = path.join('/tmp/', file);
                const base64 = fs.readFileSync(filePath, { encoding: 'base64' });
                fs.unlinkSync(filePath); // Destrucción de la imagen temporal
                return `data:image/jpeg;base64,${base64}`;
            });

            // Destrucción del PDF original
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

            // Devolver todas las imágenes a Lovable
            res.json({ thumbnails: base64Images });

        } catch (e) {
            console.error('Error procesando archivos generados:', e);
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            res.status(500).send('Error empaquetando imágenes');
        }
    });
});

// ==========================================
// 3. MOTOR DE CENSURA LEGAL (PyMuPDF)
// ==========================================
app.post('/v1/redact', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const inputPath = req.file.path;
    const outputPath = path.join('/tmp', `censurado_${Date.now()}.pdf`);
    const patterns = req.body.patterns || '[]'; // Array de regex en formato string

    const cmd = `python3 redact.py "${inputPath}" "${outputPath}" '${patterns}'`;

    exec(cmd, (error) => {
        if (error) {
            console.error('Error censurando:', error);
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            return res.status(500).send('Fallo en el motor de censura');
        }

        res.download(outputPath, 'pdfcadabra-seguro.pdf', () => {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        });
    });
});

app.listen(port, () => console.log(`Motor PDFcadabra escuchando en el puerto ${port}`));
