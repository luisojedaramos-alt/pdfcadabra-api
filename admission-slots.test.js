// admitUpload cuenta huecos ocupados, no peticiones: con un trabajo grande (peso 2) y uno
// normal en marcha, los 3 huecos están llenos aunque solo haya 2 peticiones. Con la cola
// llena (8), la siguiente subida recibe 503 QUEUE_FULL ANTES de enviar el cuerpo (antes
// contaba 2 + 8 = 10 de 11, la admitía y el 503 llegaba tras recibir el archivo entero).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');

// Carpeta temporal propia: los demás archivos de test escriben a la vez en la compartida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-slots-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;
process.env.HEAVY_MAX_CONCURRENT = '3';
process.env.HEAVY_MAX_QUEUE = '8';
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
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
// El plan Pro aún no tiene cuentas: se simula con app.locals.planFor.
app.locals.planFor = (req) => (req.get('X-Test-Plan') === 'pro' ? 'pro' : 'free');

const MB = 1024 * 1024;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function post(base, id, size, plan) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(size, 'a')], { type: 'application/pdf' }), 'in.pdf');
    const headers = { Origin: 'https://pdfcadabra.com', 'X-Request-Id': id };
    if (plan) headers['X-Test-Plan'] = plan;
    const res = fetch(`${base}/v1/compress`, { method: 'POST', body: form, headers });
    res.catch(() => {});
    return res;
}

const status = async (base, id) => (await fetch(`${base}/v1/queue/status/${id}`)).json();

async function until(cond, what) {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`No se cumplió: ${what}`);
}

test('peso 2 + peso 1 en marcha y 8 en cola: la siguiente subida, 503 sin enviar el cuerpo', { timeout: 30000 }, async (t) => {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        calls.splice(0).forEach((finish) => finish());
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    t.mock.method(console, 'error', () => {});

    post(base, uuid(1), 51 * MB, 'pro'); // más de LARGE_JOB_BYTES: peso 2
    await until(async () => (await status(base, uuid(1))).state === 'running', 'el grande en marcha');
    post(base, uuid(2), 1000);
    await until(async () => (await status(base, uuid(2))).state === 'running', 'el normal en marcha');
    const queued = [3, 4, 5, 6, 7, 8, 9, 10].map(uuid);
    queued.forEach((id) => post(base, id, 1000));
    // Llegan en cualquier orden: se espera a que estén las 8 en cola, no a una posición concreta.
    await until(async () => (await Promise.all(queued.map((id) => status(base, id)))).every((s) => s.state === 'queued'), '8 en cola');

    // Solo cabeceras: anuncia 1 MB que nunca envía.
    const BOUNDARY = 'limite-de-prueba';
    const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="in.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
    const req = http.request({
        port, host: '127.0.0.1', method: 'POST', path: '/v1/compress',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
            'Content-Length': Buffer.byteLength(head) + MB, Origin: 'https://pdfcadabra.com'
        }
    });
    t.after(() => req.destroy());
    const response = new Promise((resolve, reject) => {
        req.on('response', (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
    });
    response.catch(() => {});
    req.write(head);
    const noAnswer = new Promise((r) => setTimeout(() => r(null), 2000));
    const rejected = await Promise.race([response, noAnswer]);
    assert.ok(rejected, 'sin respuesta antes del cuerpo: la subida se admitió con los huecos llenos');
    assert.equal(rejected.status, 503);
    assert.equal(JSON.parse(rejected.body).code, 'QUEUE_FULL');
    assert.equal(rejected.headers['retry-after'], '10');
});
