// /v1/redact/search: si redact.py sale con EXIT_BAD_PATTERNS (patrones que no son un objeto
// de cadenas no vacías), 400 y no 500, sin dejar temporales. Los patrones que server.js ya
// rechaza (no son un objeto JSON) no llegan a redact.py (redact-fields.test.js); aquí,
// los que sí son un objeto pero con algún valor que no vale. redact.py se simula sustituyendo
// execFile antes de cargar server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// Carpeta temporal propia: los demás archivos de test escriben a la vez en la compartida.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-bad-patterns-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;

const EXIT_BAD_PATTERNS = 4; // redact.EXIT_BAD_PATTERNS
let exitCode = EXIT_BAD_PATTERNS;
childProcess.execFile = (command, args, options, callback) => {
    setImmediate(() => {
        const error = Object.assign(new Error('Command failed'), { code: exitCode, killed: false, signal: null });
        callback(error, '', 'Patrones no válidos en redact.py: hay un patrón que no es una cadena no vacía\n');
    });
    return { kill() {} };
};

const app = require('./server');
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
assert.ok(UPLOAD_DIR.startsWith(TMP));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function search(t, patterns) {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('%PDF-1.4 entrada')], { type: 'application/pdf' }), 'in.pdf');
    form.append('patterns', patterns);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/redact/search`, {
        method: 'POST', body: form, headers: { Origin: 'https://pdfcadabra.com' }
    });
    const body = await res.json();
    await new Promise((r) => setTimeout(r, 150)); // el borrado es asíncrono
    return { res, body };
}

test('patrón vacío o que no es una cadena: 400 BAD_PATTERNS, sin temporales', async (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    exitCode = EXIT_BAD_PATTERNS;
    const { res, body } = await search(t, '{"dni": ""}');
    assert.equal(res.status, 400);
    assert.equal(body.code, 'BAD_PATTERNS');
    assert.match(body.error, /patrones/);
    assert.deepEqual(fs.readdirSync(UPLOAD_DIR), []);
});

test('cualquier otro fallo de redact.py sigue siendo un 500', async (t) => {
    t.mock.method(console, 'error', () => {});
    exitCode = 1;
    const { res } = await search(t, '{"dni": "x"}');
    assert.equal(res.status, 500);
});
