// Límite de subida de 20 MB: con 20 MB exactos pasa; con un byte más, 413 FILE_TOO_LARGE
// (también sin Content-Length); y si el Content-Length ya anuncia de más, el 413 llega sin
// haber enviado el cuerpo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');

// Carpeta temporal propia: los demás archivos de test escriben a la vez en la compartida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-limit-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;

// Comprimir simulado: lossless_images.py dice que no hay nada que proteger y gs devuelve
// una salida mínima (así la respuesta pesa poco).
childProcess.execFile = (command, args, options, callback) => {
    if (command === 'gs') {
        const out = args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
        fs.writeFileSync(out, '%PDF-1.4\n%%EOF\n');
    }
    if (args[0] === 'jpeg_flate.py') fs.copyFileSync(args[1], args[2]);
    setImmediate(() => callback(null, args[0] === 'lossless_images.py' ? '0\n' : '', ''));
    return { kill() {} };
};

const app = require('./server');
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
assert.ok(UPLOAD_DIR.startsWith(TMP));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MB = 1024 * 1024;
const LIMIT = 20 * MB;
const BOUNDARY = 'limite-de-prueba';
const HEAD = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="in.pdf"\r\nContent-Type: application/pdf\r\n\r\n`);
const TAIL = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);

// POST a /v1/compress con un archivo de `size` bytes. chunked: sin Content-Length.
// headersOnly: anuncia el cuerpo pero no envía nada.
function post(port, size, { chunked = false, headersOnly = false, contentLength } = {}) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` };
        if (!chunked) headers['Content-Length'] = contentLength ?? HEAD.length + size + TAIL.length;
        const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/v1/compress', headers });
        req.on('response', (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                req.destroy();
                resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
            });
        });
        // Al responder 413 a mitad del envío, el servidor puede cerrar la conexión: no es un fallo.
        req.on('error', (err) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? null : reject(err)));
        if (headersOnly) return req.flushHeaders();
        req.write(HEAD);
        const chunk = Buffer.alloc(MB, 'a');
        let left = size;
        const pump = () => {
            while (left > 0) {
                const n = Math.min(left, chunk.length);
                left -= n;
                if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return req.once('drain', pump);
            }
            req.end(TAIL);
        };
        pump();
    });
}

async function listen(t) {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    return server.address().port;
}

const assertTooLarge = (res) => {
    assert.equal(res.status, 413);
    assert.deepEqual(JSON.parse(res.body), { error: 'FILE_TOO_LARGE', message: 'El archivo supera el máximo de 20 MB.' });
};

test('20 MB exactos: pasa', { timeout: 20000 }, async (t) => {
    const port = await listen(t);
    assert.equal((await post(port, LIMIT)).status, 200);
    assert.equal((await post(port, LIMIT, { chunked: true })).status, 200);
});

test('20 MB + 1 byte: 413 FILE_TOO_LARGE, con y sin Content-Length, sin dejar archivos', { timeout: 20000 }, async (t) => {
    const port = await listen(t);
    const warn = t.mock.method(console, 'warn', () => {});
    assertTooLarge(await post(port, LIMIT + 1));
    assertTooLarge(await post(port, LIMIT + 1, { chunked: true }));
    assert.equal(warn.mock.callCount(), 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(fs.readdirSync(UPLOAD_DIR), [], 'multer borra el parcial');
});

test('Content-Length por encima del límite más el margen del multipart: 413 sin enviar el cuerpo', { timeout: 20000 }, async (t) => {
    const port = await listen(t);
    t.mock.method(console, 'warn', () => {});
    const res = await post(port, 0, { headersOnly: true, contentLength: 25 * MB + 1 });
    assertTooLarge(res);
    assert.equal(res.headers.connection, 'close');
    // Justo en el margen (25 MB) no se rechaza por cabecera: lo decide multer con el archivo.
    const atMargin = post(port, 0, { headersOnly: true, contentLength: 25 * MB });
    atMargin.catch(() => {});
    const first = await Promise.race([atMargin, new Promise((r) => setTimeout(() => r('esperando el cuerpo'), 300))]);
    assert.equal(first, 'esperando el cuerpo');
});
