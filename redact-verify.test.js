// /v1/redact/apply y la verificación final de redact.py: sin informe o con
// verified !== true no se envía el documento (422 REDACT_NOT_VERIFIED), si falla alguna censura
// tampoco (422 REDACT_ITEMS_FAILED), y las páginas con
// texto perdido fuera de las zonas censuradas llegan en X-Redact-Text-Loss. redact.py se
// simula sustituyendo execFile antes de cargar server.js (como en compress-timeout.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');

const OUTPUT = Buffer.from('%PDF-1.4\n% salida simulada de redact.py\n%%EOF\n');
// Informe que escribe el redact.py simulado (null = no escribe ninguno).
let report = null;
const written = [];

childProcess.execFile = (command, args, options, callback) => {
    // python3 redact.py apply <entrada> <salida> <hallazgos> <informe>
    const [, , , outputPath, , resultsPath] = args;
    setImmediate(() => {
        fs.writeFileSync(outputPath, OUTPUT);
        written.push(outputPath);
        if (report) fs.writeFileSync(resultsPath, JSON.stringify(report));
        callback(null, '', '');
    });
    return {};
};

const app = require('./server');

async function apply(t) {
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4 entrada')], { type: 'application/pdf' }), 'in.pdf');
    form.append('items', JSON.stringify([{ id: 'a', page: 0, rect: [0, 0, 10, 10], text: 'x' }]));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/redact/apply`, {
        method: 'POST',
        body: form,
    });
    const body = Buffer.from(await res.arrayBuffer());
    await new Promise((r) => setTimeout(r, 150)); // el borrado es asíncrono
    return { res, body };
}

test('verificación fallida: 422 REDACT_NOT_VERIFIED, sin documento y sin temporales', async (t) => {
    report = { success: false, verified: false, leaks: ['form_fields'], applied: 1, failed: [] };
    const { res, body } = await apply(t);
    assert.equal(res.status, 422);
    const json = JSON.parse(body.toString());
    assert.equal(json.code, 'REDACT_NOT_VERIFIED');
    assert.match(json.error, /no se ha descargado nada/);
    assert.ok(!body.includes(OUTPUT));
    assert.equal(fs.existsSync(written.at(-1)), false);
});

test('sin informe de redact.py tampoco se envía el documento', async (t) => {
    report = null;
    const { res, body } = await apply(t);
    assert.equal(res.status, 422);
    assert.equal(JSON.parse(body.toString()).code, 'REDACT_NOT_VERIFIED');
});

test('verificado con texto perdido: se envía con X-Redact-Text-Loss', async (t) => {
    report = { success: true, verified: true, applied: 1, failed: [], text_loss_pages: [2, 5] };
    const { res, body } = await apply(t);
    assert.equal(res.status, 200);
    assert.deepEqual(body, OUTPUT);
    assert.equal(res.headers.get('x-redact-text-loss'), '[2,5]');
});

test('verificado sin pérdidas: sin cabecera de aviso', async (t) => {
    report = { success: true, verified: true, applied: 1, failed: [], text_loss_pages: [] };
    const { res, body } = await apply(t);
    assert.equal(res.status, 200);
    assert.deepEqual(body, OUTPUT);
    assert.equal(res.headers.get('x-redact-text-loss'), null);
});

test('una censura fallida (de varias): 422 REDACT_ITEMS_FAILED, sin documento y sin temporales', async (t) => {
    const failed = [{ id: 'b', error: 'page 9 not in document' }];
    report = { success: true, verified: true, applied: 1, failed, text_loss_pages: [] };
    const { res, body } = await apply(t);
    assert.equal(res.status, 422);
    const json = JSON.parse(body.toString());
    assert.equal(json.code, 'REDACT_ITEMS_FAILED');
    assert.deepEqual(json.failed, failed);
    assert.ok(!body.includes(OUTPUT));
    assert.equal(res.headers.get('x-redact-warnings'), null);
    assert.equal(fs.existsSync(written.at(-1)), false);
});

test('todas las censuras fallidas: 422 REDACT_ITEMS_FAILED', async (t) => {
    report = { success: true, verified: true, applied: 0, failed: [{ id: 'a', error: 'x' }], text_loss_pages: [] };
    const { res, body } = await apply(t);
    assert.equal(res.status, 422);
    assert.equal(JSON.parse(body.toString()).code, 'REDACT_ITEMS_FAILED');
});
