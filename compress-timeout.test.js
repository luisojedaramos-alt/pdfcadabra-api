// Tope total de /v1/compress (COMPRESS_TOTAL_TIMEOUT_MS): si se agota después de
// Ghostscript, se devuelve su salida en vez de un error. gs y jpeg_flate.py se simulan
// sustituyendo execFile antes de cargar server.js (que lo desestructura al importarse).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');

const TOTAL_MS = 300;
// Margen para los topes calculados con Date.now(): el reloj puede avanzar mientras se preparan.
const TIMER_MARGIN_MS = 20;
process.env.COMPRESS_TOTAL_TIMEOUT_MS = String(TOTAL_MS);

const GS_OUTPUT = Buffer.from('%PDF-1.4\n% salida simulada de Ghostscript\n%%EOF\n');
let gsDelayMs = 0;
// Imágenes que lossless_images.py dice haber protegido (con > 0, la salida de gs lleva marcadores).
let protectedCount = 0;
const calls = [];

childProcess.execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    // pdf_check.py verify (comprobación del resultado antes de entregarlo): todo bien.
    if (args[0] === 'pdf_check.py') {
        setImmediate(() => callback(null, '', ''));
        return {};
    }
    if (args[0] === 'lossless_images.py') {
        if (protectedCount > 0) fs.copyFileSync(args[2], args[3]);
        setImmediate(() => callback(null, `${protectedCount}
`, ''));
        return {};
    }
    if (command === 'gs') {
        // Escribe su salida y termina bien (el falso no respeta su timeout: así se puede
        // simular un gs que acaba justo después de agotarse el tope).
        const out = args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
        setTimeout(() => {
            fs.writeFileSync(out, GS_OUTPUT);
            callback(null, '', '');
        }, gsDelayMs);
    } else {
        // jpeg_flate.py que no termina: lo mata su timeout, como haría execFile.
        setTimeout(() => {
            callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }), '', '');
        }, options.timeout);
    }
    return {};
};

const app = require('./server');

async function compress(t) {
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));

    const form = new FormData();
    // Más grande que la salida simulada, para que cuente como comprimido.
    form.append('file', new Blob([Buffer.alloc(10000, 'a')], { type: 'application/pdf' }), 'in.pdf');
    form.append('level', 'extreme');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/compress`, { method: 'POST', body: form });
    return { res, body: Buffer.from(await res.arrayBuffer()) };
}

const gsOutputPath = () => calls.find((c) => c.command === 'gs').args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);

async function assertCleanedUp(file) {
    await new Promise((r) => setTimeout(r, 100)); // secureCleanup borra de forma asíncrona
    assert.equal(fs.existsSync(file), false, 'la salida de gs debe borrarse tras el envío');
}

test('si el tope se agota en jpeg_flate.py, devuelve la salida de Ghostscript', async (t) => {
    calls.length = 0;
    protectedCount = 0;
    gsDelayMs = 5;
    const { res, body } = await compress(t);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-compress-status'), 'compressed');
    assert.deepEqual(body, GS_OUTPUT);

    const gs = calls.find((c) => c.command === 'gs');
    const py = calls.find((c) => c.args[0] === 'jpeg_flate.py');
    // gs recibe lo que queda del tope total: deadline - Date.now() al lanzarlo, así que
    // puede llegar con 1-2 ms menos si entre medias pasa el reloj (mkdirSync, etc.).
    assert.ok(gs.options.timeout <= TOTAL_MS && gs.options.timeout >= TOTAL_MS - TIMER_MARGIN_MS,
        `gs debe tener el tope total, salvo unos ms (tuvo ${gs.options.timeout} ms)`);
    assert.ok(py.options.timeout > 0 && py.options.timeout <= TOTAL_MS - gsDelayMs,
        `jpeg_flate.py solo debe tener el tiempo sobrante (tuvo ${py.options.timeout} ms)`);
    await assertCleanedUp(gsOutputPath());
});

test('si el tope ya se agotó al acabar Ghostscript, devuelve su salida sin lanzar jpeg_flate.py', async (t) => {
    calls.length = 0;
    protectedCount = 0;
    gsDelayMs = TOTAL_MS + 50;
    const { res, body } = await compress(t);

    assert.equal(res.status, 200);
    assert.deepEqual(body, GS_OUTPUT);
    assert.equal(calls.some((c) => c.args[0] === 'jpeg_flate.py'), false);
    await assertCleanedUp(gsOutputPath());
});

// Con imágenes protegidas, la salida de gs lleva marcadores en lugar de los códigos de
// barras: nunca se envía sin el paso que las restaura.
test('con imágenes protegidas, si el tope se agota en jpeg_flate.py: 504, no la salida de gs', async (t) => {
    calls.length = 0;
    protectedCount = 2;
    gsDelayMs = 5;
    const { res, body } = await compress(t);

    assert.equal(res.status, 504);
    assert.notDeepEqual(body, GS_OUTPUT);
    const gs = calls.find((c) => c.command === 'gs');
    assert.match(gs.args.at(-1), /_protected\.pdf$/, 'gs lee la entrada con marcadores');
    await assertCleanedUp(gsOutputPath());
});

test('con imágenes protegidas, si el tope se agota en gs: 504 sin lanzar jpeg_flate.py', async (t) => {
    calls.length = 0;
    protectedCount = 1;
    gsDelayMs = TOTAL_MS + 50;
    const { res, body } = await compress(t);

    assert.equal(res.status, 504);
    assert.notDeepEqual(body, GS_OUTPUT);
    assert.equal(calls.some((c) => c.args[0] === 'jpeg_flate.py'), false);
    await assertCleanedUp(gsOutputPath());
});
