// Lista de hallazgos (`items`) de /v1/redact/apply: hasta 16 MB (con 50 MB salen decenas de
// miles); por encima, 413 ITEMS_TOO_LARGE sin dejar archivos. Las demás rutas siguen con
// campos de 1 MB. Margen del Content-Length: 50 MB + 33 en apply, 50 + 5 en el resto.
// redact.py se simula: copia la lista que recibe para comprobar que llega entera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');

// Carpeta temporal propia: los demás archivos de test escriben a la vez en la compartida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-items-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;

let received = null; // texto de la lista que leyó el redact.py simulado
childProcess.execFile = (command, args, options, callback) => {
    if (args[1] === 'apply') {
        // python3 redact.py apply <entrada> <salida> <hallazgos> <informe>
        const [, , , outputPath, itemsPath, resultsPath] = args;
        received = fs.readFileSync(itemsPath, 'utf-8');
        const applied = JSON.parse(received).length;
        fs.writeFileSync(outputPath, '%PDF-1.4\n%%EOF\n');
        fs.writeFileSync(resultsPath, JSON.stringify({ success: true, verified: true, applied, failed: [] }));
    } else {
        // search: sin hallazgos
        fs.writeFileSync(args[4], JSON.stringify({ results: [], errors: [] }));
    }
    setImmediate(() => callback(null, '', ''));
    return { kill() {} };
};

const app = require('./server');
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
assert.ok(UPLOAD_DIR.startsWith(TMP));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MB = 1024 * 1024;

async function listen(t) {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    return server.address().port;
}

// Hallazgos con los campos que devuelve /v1/redact/search (unos 230 bytes cada uno; los
// reales, unos 330).
const findings = (n) => Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    page: i % 2600, page_width: 595, page_height: 842,
    text: `${String(10000000 + i)}Z`, context: '...Interesado con DNI 12345678Z, correo persona@ejemplo.com...',
    category: 'DNI', rect: [40.0, 50.5, 120.25, 58.75]
}));

async function post(port, route, fields) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4 entrada')], { type: 'application/pdf' }), 'in.pdf');
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', body: form, headers: { Origin: 'https://pdfcadabra.com' }
    });
    const body = Buffer.from(await res.arrayBuffer());
    await new Promise((r) => setTimeout(r, 150)); // el borrado es asíncrono
    return { res, body };
}

test('20.000 hallazgos en apply: llegan enteros a redact.py y se entrega el documento', async (t) => {
    const port = await listen(t);
    const items = JSON.stringify(findings(20000));
    assert.ok(items.length > 4 * MB, `la lista ocupa ${items.length} bytes (antes, máx. 1 MB)`);
    const { res } = await post(port, '/v1/redact/apply', { items });
    assert.equal(res.status, 200);
    assert.equal(received, items);
    assert.deepEqual(fs.readdirSync(UPLOAD_DIR), []);
});

test('items de 16 MB exactos pasan; con un byte más, 413 ITEMS_TOO_LARGE sin dejar archivos', async (t) => {
    const port = await listen(t);
    t.mock.method(console, 'warn', () => {});
    // JSON válido de 16 MB exactos: una lista con una cadena de relleno.
    const exact = JSON.stringify(['x'.repeat(16 * MB - 4)]);
    assert.equal(Buffer.byteLength(exact), 16 * MB);
    assert.equal((await post(port, '/v1/redact/apply', { items: exact })).res.status, 200);

    const { res, body } = await post(port, '/v1/redact/apply', { items: exact + ' ' });
    assert.equal(res.status, 413);
    assert.deepEqual(JSON.parse(body.toString()), {
        error: 'ITEMS_TOO_LARGE', message: 'La lista de datos que censurar supera el máximo de 16 MB.'
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://pdfcadabra.com');
    assert.deepEqual(fs.readdirSync(UPLOAD_DIR), [], 'multer borra la subida');
});

test('las demás rutas siguen con campos de 1 MB: patterns de más, 400 UPLOAD_ERROR', async (t) => {
    const port = await listen(t);
    t.mock.method(console, 'warn', () => {});
    const { res, body } = await post(port, '/v1/redact/search', { patterns: JSON.stringify({ a: 'x'.repeat(MB) }) });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(body.toString()).error, 'UPLOAD_ERROR');
});

// POST que solo anuncia el cuerpo: ¿responde sin esperarlo (413) o se queda esperando?
function announce(port, route, contentLength) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            port, host: '127.0.0.1', method: 'POST', path: route,
            headers: { 'Content-Type': 'multipart/form-data; boundary=b', 'Content-Length': contentLength, Origin: 'https://pdfcadabra.com' }
        });
        const timer = setTimeout(() => { req.destroy(); resolve('esperando el cuerpo'); }, 300);
        req.on('response', (res) => { clearTimeout(timer); req.destroy(); resolve(res.statusCode); });
        req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
        req.flushHeaders();
    });
}

test('Content-Length: apply admite 50 + 33 MB y el resto 50 + 5', async (t) => {
    const port = await listen(t);
    t.mock.method(console, 'warn', () => {});
    // 2 campos de 16 MB + 1 byte (ver APPLY_FIELDS) + 1 MB.
    const applyMax = 50 * MB + 2 * (16 * MB + 1) + MB;
    assert.equal(await announce(port, '/v1/redact/apply', applyMax), 'esperando el cuerpo');
    assert.equal(await announce(port, '/v1/redact/apply', applyMax + 1), 413);
    assert.equal(await announce(port, '/v1/redact/search', 55 * MB + 1), 413);
    assert.equal(await announce(port, '/v1/compress', 55 * MB + 1), 413);
});
