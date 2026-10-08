// Cola llena: el 503 QUEUE_FULL llega ANTES de recibir el cuerpo, contando también las
// subidas en curso (antes llegaba tras recibir el archivo entero). Con 1 hueco y cola 0,
// un cliente lento que aún está subiendo ya ocupa la capacidad entera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');

// Carpeta temporal propia: los demás archivos de test escriben a la vez en la compartida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;
process.env.HEAVY_MAX_CONCURRENT = '1';
process.env.HEAVY_MAX_QUEUE = '0';

// Comprimir simulado: todo termina bien al momento (gs y jpeg_flate.py copian su entrada).
childProcess.execFile = (command, args, options, callback) => {
    if (command === 'gs') {
        const out = args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
        fs.copyFileSync(args.at(-1), out);
    }
    if (args[0] === 'jpeg_flate.py') fs.copyFileSync(args[1], args[2]);
    setImmediate(() => callback(null, args[0] === 'lossless_images.py' ? '0\n' : '', ''));
    return { kill() {} };
};

const app = require('./server');
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
assert.ok(UPLOAD_DIR.startsWith(TMP));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const BOUNDARY = 'limite-de-prueba';
const PART_HEAD = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="in.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
const PART_TAIL = `\r\n--${BOUNDARY}--\r\n`;

// POST multipart a /v1/compress que envía las cabeceras y `sent` bytes del archivo, y
// espera. Devuelve { req, response } (response: promesa de { status, headers, body }).
function slowUpload(port, fileSize, sent) {
    const length = Buffer.byteLength(PART_HEAD) + fileSize + Buffer.byteLength(PART_TAIL);
    const req = http.request({
        port, host: '127.0.0.1', method: 'POST', path: '/v1/compress',
        headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Content-Length': length, Origin: 'https://pdfcadabra.com' }
    });
    const response = new Promise((resolve, reject) => {
        req.on('response', (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
    });
    response.catch(() => {}); // un corte provocado por el test no es un fallo sin gestionar
    req.write(PART_HEAD);
    if (sent > 0) req.write(Buffer.alloc(sent, 'a'));
    else req.flushHeaders();
    const finish = () => req.end(Buffer.concat([Buffer.alloc(fileSize - sent, 'a'), Buffer.from(PART_TAIL)]));
    return { req, response, finish };
}

const uploads = () => new Set(fs.readdirSync(UPLOAD_DIR));

test('con la capacidad ocupada por una subida en curso, la siguiente recibe 503 sin enviar el cuerpo', { timeout: 10000 }, async (t) => {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();

    // Cliente lento: ha enviado la mitad de un archivo de 64 KB y sigue conectado.
    const slow = slowUpload(port, 64 * 1024, 32 * 1024);
    await new Promise((r) => setTimeout(r, 100));
    const before = uploads();

    // Segundo cliente: solo cabeceras (anuncia 10 MB que nunca envía).
    const blocked = slowUpload(port, 10 * 1024 * 1024, 0);
    const rejected = await blocked.response;
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers['retry-after'], '10');
    assert.equal(rejected.headers.connection, 'close');
    assert.equal(JSON.parse(rejected.body).code, 'QUEUE_FULL');
    blocked.req.destroy();
    assert.deepEqual(uploads(), before, 'el rechazado no crea ningún archivo');

    // El lento termina su subida y se procesa con normalidad.
    slow.finish();
    assert.equal((await slow.response).status, 200);

    // Con el hueco libre, una nueva subida entra.
    const after = slowUpload(port, 1024, 0);
    after.finish();
    assert.equal((await after.response).status, 200);
});

test('una subida que se corta a medias deja de contar', { timeout: 10000 }, async (t) => {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();

    const cut = slowUpload(port, 64 * 1024, 1024);
    cut.response.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    cut.req.destroy();
    await new Promise((r) => setTimeout(r, 100));

    const next = slowUpload(port, 1024, 0);
    next.finish();
    assert.equal((await next.response).status, 200);
});
