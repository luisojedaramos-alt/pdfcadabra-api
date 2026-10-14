// /v1/redact/apply: pase lo que pase con redact.py (tope de tiempo con SIGKILL, error, verificación
// fallida, censuras fallidas o éxito), no queda ningún temporal: ni la subida, ni los hallazgos,
// ni la salida, ni el informe, ni las copias de trabajo de las capas OCG (que redact.py solo
// deja si se le mata). redact.py se simula sustituyendo execFile antes de cargar server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// Carpeta temporal propia: los demás archivos de test escriben a la vez en la compartida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-cleanup-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;

const OUTPUT = Buffer.from('%PDF-1.4\n% salida simulada de redact.py\n%%EOF\n');
// Cómo termina el redact.py simulado: { error, report } (report null = no escribe informe).
let outcome = null;
childProcess.execFile = (command, args, options, callback) => {
    // python3 redact.py apply <entrada> <salida> <hallazgos> <informe>
    const [, , , outputPath, , resultsPath] = args;
    setImmediate(() => {
        fs.writeFileSync(outputPath, OUTPUT);
        for (const copy of ['.capas.pdf', '.pre.pdf', '.pre.pdf.capas.pdf']) fs.writeFileSync(outputPath + copy, OUTPUT);
        if (outcome.report) fs.writeFileSync(resultsPath, JSON.stringify(outcome.report));
        callback(outcome.error, '', '');
    });
    return { kill() {} };
};

const app = require('./server');
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
assert.ok(UPLOAD_DIR.startsWith(TMP));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const killed = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGKILL', code: null });
const crashed = Object.assign(new Error('Command failed'), { killed: false, signal: null, code: 1 });
const CASES = [
    ['tope de tiempo (SIGKILL)', { error: killed, report: null }, 504],
    ['error de redact.py', { error: crashed, report: null }, 500],
    ['verificación fallida', { error: null, report: { verified: false, leaks: ['outline'], applied: 1, failed: [] } }, 422],
    ['censuras fallidas', { error: null, report: { verified: true, applied: 0, failed: [{ id: 'a', error: 'x' }] } }, 422],
    ['éxito', { error: null, report: { verified: true, applied: 1, failed: [], text_loss_pages: [] } }, 200],
];

for (const [name, result, status] of CASES) {
    test(`${name}: ${status} y ningún temporal en la carpeta de subidas`, async (t) => {
        t.mock.method(console, 'error', () => {});
        outcome = result;
        const server = app.listen(0, '127.0.0.1');
        t.after(() => server.close());
        await new Promise((r) => server.once('listening', r));
        const form = new FormData();
        form.append('file', new Blob([Buffer.from('%PDF-1.4 entrada')], { type: 'application/pdf' }), 'in.pdf');
        form.append('items', JSON.stringify([{ id: 'a', page: 0, rect: [0, 0, 10, 10], text: 'x' }]));
        const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/redact/apply`, {
            method: 'POST', body: form, headers: { Origin: 'https://pdfcadabra.com' }
        });
        await res.arrayBuffer();
        assert.equal(res.status, status);
        await new Promise((r) => setTimeout(r, 150)); // el borrado es asíncrono
        assert.deepEqual(fs.readdirSync(UPLOAD_DIR), []);
    });
}
