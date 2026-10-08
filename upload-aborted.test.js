// Subida cortada por el cliente a mitad del cuerpo: un aviso, no "Error no gestionado".
// Los errores reales siguen saliendo como error: un multipart mal formado con la conexión
// abierta y un multipart sin boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Carpeta temporal propia: los demás archivos de test escriben a la vez en la compartida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-aborted-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;

const app = require('./server');
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
assert.ok(UPLOAD_DIR.startsWith(TMP));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const BOUNDARY = 'limite-de-prueba';
const HEAD = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="in.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;

async function listen(t) {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    return server.address().port;
}

function captureLogs(t) {
    const logs = { warn: [], error: [] };
    for (const level of ['warn', 'error']) {
        t.mock.method(console, level, (...args) => logs[level].push(args.map(String).join(' ')));
    }
    return logs;
}

const post = (port, path, length, headers = {}) => http.request({
    port, host: '127.0.0.1', method: 'POST', path,
    headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Content-Length': length, Origin: 'https://pdfcadabra.com', ...headers }
});

async function waitFor(check, ms = 3000) {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

test('subida cortada a medias: aviso, sin "Error no gestionado" y sin archivos', async (t) => {
    const port = await listen(t);
    const logs = captureLogs(t);
    const req = post(port, '/v1/compress', 1024 * 1024);
    req.on('error', () => {});
    req.write(HEAD);
    req.write(Buffer.alloc(64 * 1024, 'a'));
    await new Promise((r) => setTimeout(r, 150));
    req.destroy();

    await waitFor(() => logs.warn.some((l) => l.includes('Subida cortada por el cliente')));
    assert.ok(logs.warn.includes('Subida cortada por el cliente.'), logs.warn.join('\n'));
    assert.deepEqual(logs.error, []);
    await waitFor(() => fs.readdirSync(UPLOAD_DIR).length === 0);
    assert.deepEqual(fs.readdirSync(UPLOAD_DIR), []);
});

test('multipart mal formado con la conexión abierta: sigue siendo un error', async (t) => {
    const port = await listen(t);
    const logs = captureLogs(t);
    const body = HEAD + 'sin cierre del multipart';
    const status = await new Promise((resolve, reject) => {
        const req = post(port, '/v1/compress', Buffer.byteLength(body));
        req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end(body);
    });
    assert.equal(status, 500);
    assert.ok(logs.error.some((l) => l.startsWith('Error no gestionado:')), logs.error.join('\n'));
    assert.ok(!logs.warn.some((l) => l.includes('Subida cortada')));
});

test('multipart sin boundary: sigue siendo un error', async (t) => {
    const port = await listen(t);
    const logs = captureLogs(t);
    const status = await new Promise((resolve, reject) => {
        const req = post(port, '/v1/compress', 0, { 'Content-Type': 'multipart/form-data' });
        req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end();
    });
    assert.equal(status, 500);
    assert.ok(logs.error.some((l) => l.startsWith('Error no gestionado:') && l.includes('Boundary')), logs.error.join('\n'));
    assert.ok(!logs.warn.some((l) => l.includes('Subida cortada')));
});
