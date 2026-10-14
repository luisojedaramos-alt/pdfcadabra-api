// Campos de Anonimizar: `patterns` (search) tiene que ser un objeto JSON e `items` (apply) un
// array JSON. Si no, 400 al momento, sin pasar por la cola, y sin dejar la subida en /tmp.
// Antes la comprobación iba después de heavyGate: con el único hueco ocupado, la petición
// esperaba en cola (hasta 180 s) para recibir el 400, y un JSON mal formado o de otro tipo
// llegaba a redact.py y acababa en 500.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// Carpeta temporal propia: los demás archivos de test escriben a la vez en la compartida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-fields-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;
process.env.HEAVY_MAX_CONCURRENT = '1';
process.env.HEAVY_MAX_QUEUE = '5';
process.env.IP_MAX_CONCURRENT = '20';

// Procesos simulados que no terminan hasta que el test los suelta (con error: 500).
const calls = [];
childProcess.execFile = (command, args, options, callback) => {
    let done = false;
    calls.push(() => {
        if (done) return;
        done = true;
        callback(new Error('fin del test'), '', '');
    });
    return { kill() {} };
};

const app = require('./server');
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
assert.ok(UPLOAD_DIR.startsWith(TMP));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function post(base, route, fields, id) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4 entrada')], { type: 'application/pdf' }), 'in.pdf');
    for (const [name, value] of fields) form.append(name, value);
    const headers = { Origin: 'https://pdfcadabra.com' };
    if (id) headers['X-Request-Id'] = id;
    return fetch(`${base}${route}`, { method: 'POST', body: form, headers });
}

const BUSY_ID = '00000000-0000-4000-8000-000000000001';

async function busyServer(t) {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        calls.splice(0).forEach((finish) => finish());
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.mock.method(console, 'error', () => {});
    // Ocupa el único hueco con una búsqueda que no termina.
    post(base, '/v1/redact/search', [['patterns', '{"dni":"\\\\d{8}"}']], BUSY_ID).catch(() => {});
    const end = Date.now() + 10000;
    while ((await (await fetch(`${base}/v1/queue/status/${BUSY_ID}`)).json()).state !== 'running') {
        if (Date.now() > end) throw new Error('la búsqueda que ocupa el hueco no arrancó');
        await new Promise((r) => setTimeout(r, 20));
    }
    return base;
}

const uploads = () => fs.readdirSync(UPLOAD_DIR).filter((f) => !/^(patterns|results)_/.test(f));

// Respuesta en menos de 2 s (si no, es que ha ido a la cola).
async function quick(promise) {
    const timeout = new Promise((r) => setTimeout(() => r(null), 2000));
    const res = await Promise.race([promise, timeout]);
    assert.ok(res, 'sin respuesta en 2 s: la petición ha ido a la cola');
    return res;
}

const BAD = {
    '/v1/redact/search': [
        ['sin patterns', []],
        ['patterns no es JSON', [['patterns', '{dni: x']]],
        ['patterns es un array', [['patterns', '["\\\\d{8}"]']]],
        ['patterns es una cadena JSON', [['patterns', '"\\\\d{8}"']]],
        ['patterns es null', [['patterns', 'null']]],
        ['patterns repetido', [['patterns', '{}'], ['patterns', '{}']]],
    ],
    '/v1/redact/apply': [
        ['sin items', []],
        ['items no es JSON', [['items', '[{"page": 0']]],
        ['items es un objeto', [['items', '{"page": 0, "rect": [0, 0, 1, 1]}']]],
        ['items es un número', [['items', '3']]],
    ],
};

for (const [route, cases] of Object.entries(BAD)) {
    test(`${route}: campos no válidos, 400 al momento con el hueco ocupado y sin dejar la subida`, { timeout: 30000 }, async (t) => {
        const base = await busyServer(t);
        const before = uploads();
        for (const [name, fields] of cases) {
            const res = await quick(post(base, route, fields));
            assert.equal(res.status, 400, name);
            assert.match((await res.json()).error, /patrones|hallazgos/, name);
        }
        await new Promise((r) => setTimeout(r, 150)); // el borrado es asíncrono
        assert.deepEqual(uploads(), before, 'no queda ninguna subida de las rechazadas');
    });
}

test('campos válidos sí van a la cola', { timeout: 30000 }, async (t) => {
    const base = await busyServer(t);
    const id = '00000000-0000-4000-8000-000000000002';
    post(base, '/v1/redact/apply', [['items', '[]']], id).catch(() => {});
    const end = Date.now() + 10000;
    while ((await (await fetch(`${base}/v1/queue/status/${id}`)).json()).state !== 'queued') {
        if (Date.now() > end) throw new Error('la petición válida no llegó a la cola');
        await new Promise((r) => setTimeout(r, 20));
    }
});
