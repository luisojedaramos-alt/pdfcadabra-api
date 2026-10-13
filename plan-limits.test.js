// Topes de cada plan, peso de los trabajos grandes y espera máxima en cola, con los valores
// por defecto (sin variables de entorno de topes). Los procesos hijos se simulan: no
// terminan hasta que el test los suelta. El plan Pro aún no tiene cuentas: se simula con
// app.locals.planFor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// Carpeta temporal propia: los demás archivos de test escriben a la vez en la compartida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-limits-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;
for (const name of ['HEAVY_EXEC_TIMEOUT_MS', 'COMPRESS_TOTAL_TIMEOUT_MS', 'PRO_HEAVY_EXEC_TIMEOUT_MS',
    'PRO_COMPRESS_TOTAL_TIMEOUT_MS', 'HEAVY_QUEUE_TIMEOUT_MS']) delete process.env[name];
process.env.HEAVY_MAX_CONCURRENT = '3';
process.env.HEAVY_MAX_QUEUE = '8';
process.env.IP_MAX_CONCURRENT = '20';

// Procesos lanzados: { command, args, options, finish }. finish() los termina con error
// (la ruta responde 500 y libera el hueco); una segunda llamada no hace nada.
const calls = [];
childProcess.execFile = (command, args, options, callback) => {
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        callback(new Error('fin del test'), '', '');
    };
    const call = { command, args, options, finish };
    calls.push(call);
    return { kill() {} };
};

const app = require('./server');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MB = 1024 * 1024;
const tick = () => new Promise((r) => setImmediate(r));

async function listen(t) {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        calls.splice(0).forEach((c) => c.finish());
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    return `http://127.0.0.1:${server.address().port}`;
}

// POST a una ruta pesada con un archivo de `size` bytes; devuelve la promesa de la respuesta.
function post(base, route, id, size = 1000) {
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(size, 'a')], { type: 'application/pdf' }), 'in.pdf');
    form.append('patterns', '{}');
    return fetch(`${base}${route}`, {
        method: 'POST', body: form, headers: { Origin: 'https://pdfcadabra.com', 'X-Request-Id': id }
    });
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const status = async (base, id) => (await fetch(`${base}/v1/queue/status/${id}`)).json();

// Espera (con setImmediate: los setTimeout pueden estar simulados) a que se cumpla `cond`.
async function until(cond, what) {
    const end = performance.now() + 20000;
    while (performance.now() < end) {
        if (await cond()) return;
        await tick();
    }
    throw new Error(`No se cumplió: ${what}`);
}

test('plan gratuito: Anonimizar 180 s por proceso; Comprimir 180 s en total', async (t) => {
    const base = await listen(t);
    t.mock.method(console, 'error', () => {});
    post(base, '/v1/redact/search', uuid(1)).catch(() => {});
    post(base, '/v1/compress', uuid(2)).catch(() => {});
    await until(() => calls.length === 2, 'los dos procesos lanzados');
    const redact = calls.find((c) => c.args[0] === 'redact.py');
    const protect = calls.find((c) => c.args[0] === 'lossless_images.py');
    assert.equal(redact.options.timeout, 180000);
    // Primer proceso de Comprimir: recibe lo que queda del tope total (unos ms menos).
    assert.ok(protect.options.timeout <= 180000 && protect.options.timeout > 179000, `tuvo ${protect.options.timeout}`);
});

test('plan Pro: Anonimizar 240 s por proceso; Comprimir 330 s en total', async (t) => {
    const base = await listen(t);
    t.mock.method(console, 'error', () => {});
    t.mock.method(app.locals, 'planFor', () => 'pro');
    post(base, '/v1/redact/search', uuid(3)).catch(() => {});
    post(base, '/v1/compress', uuid(4)).catch(() => {});
    await until(() => calls.length === 2, 'los dos procesos lanzados');
    const redact = calls.find((c) => c.args[0] === 'redact.py');
    const protect = calls.find((c) => c.args[0] === 'lossless_images.py');
    assert.equal(redact.options.timeout, 240000);
    assert.ok(protect.options.timeout <= 330000 && protect.options.timeout > 329000, `tuvo ${protect.options.timeout}`);
});

test('un PDF de más de 50 MB ocupa 2 de los 3 huecos; uno de 50 MB exactos, 1', async (t) => {
    const base = await listen(t);
    t.mock.method(console, 'error', () => {});
    t.mock.method(app.locals, 'planFor', () => 'pro');

    // 50 MB exactos: uno de tres huecos. Con dos normales más, los tres corren a la vez.
    const first = [uuid(10), uuid(11), uuid(12)];
    post(base, '/v1/redact/search', first[0], 50 * MB).catch(() => {});
    await until(() => calls.length === 1, 'el de 50 MB en marcha');
    post(base, '/v1/redact/search', first[1]).catch(() => {});
    post(base, '/v1/redact/search', first[2]).catch(() => {});
    await until(() => calls.length === 3, 'tres en marcha');
    for (const id of first) assert.deepEqual(await status(base, id), { state: 'running' });
    calls.splice(0).forEach((c) => c.finish());
    await until(async () => (await status(base, first[0])).state === 'unknown', 'huecos libres');

    // Más de 50 MB: dos huecos. Cabe uno normal más; el siguiente espera.
    const large = uuid(20);
    post(base, '/v1/redact/search', large, 50 * MB + 1).catch(() => {});
    await until(() => calls.length === 1, 'el grande en marcha');
    post(base, '/v1/redact/search', uuid(21)).catch(() => {});
    await until(() => calls.length === 2, 'grande + uno normal en marcha');
    post(base, '/v1/redact/search', uuid(22)).catch(() => {});
    await until(async () => (await status(base, uuid(22))).state === 'queued', 'el tercero en cola');
    assert.deepEqual(await status(base, uuid(22)), { state: 'queued', position: 1 });

    // Al terminar el grande, entra el que esperaba.
    calls.find((c) => fs.statSync(c.args[2]).size > 50 * MB).finish();
    await until(async () => (await status(base, uuid(22))).state === 'running', 'el tercero en marcha');
});

test('espera máxima en cola: 180 s y después 503 QUEUE_TIMEOUT', async (t) => {
    const base = await listen(t);
    t.mock.method(console, 'error', () => {});
    // Los tres huecos ocupados.
    for (let i = 30; i < 33; i++) post(base, '/v1/redact/search', uuid(i)).catch(() => {});
    await until(() => calls.length === 3, 'tres en marcha');

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const waiting = post(base, '/v1/redact/search', uuid(33));
    await until(async () => (await status(base, uuid(33))).state === 'queued', 'el cuarto en cola');
    t.mock.timers.tick(179999);
    await tick();
    assert.deepEqual(await status(base, uuid(33)), { state: 'queued', position: 1 });
    t.mock.timers.tick(1);
    const res = await waiting;
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'QUEUE_TIMEOUT');
});
