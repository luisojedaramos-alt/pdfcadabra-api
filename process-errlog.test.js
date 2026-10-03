// El log de un proceso hijo que falla: código de salida y como mucho 200 caracteres de
// stderr, sin rutas de la carpeta de subidas. gs se simula (como en compress-timeout.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { describeProcessError } = require('./errlog');

const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
const DIRS = [UPLOAD_DIR, '/tmp/pdfcadabra-uploads'];
const exitError = (code) => Object.assign(new Error('Command failed'), { code });

test('código de salida y stderr sin rutas de subidas', () => {
    const stderr = "Error: /undefined in /tmp/pdfcadabra-uploads/3f2a9c1e_gs.pdf\nno se pudo abrir '/tmp/pdfcadabra-uploads/gs-1234/gs_abc'";
    assert.equal(
        describeProcessError(exitError(1), stderr, DIRS),
        "código 1: Error: /undefined in <tmp> no se pudo abrir '<tmp>'"
    );
});

test('rutas con el tmpdir del sistema (también con barras invertidas en Windows)', () => {
    const file = path.join(UPLOAD_DIR, 'a1b2c3');
    assert.equal(describeProcessError(exitError(2), `fallo en ${file} al leer`, DIRS), 'código 2: fallo en <tmp> al leer');
});

test('recorta stderr a 200 caracteres', () => {
    const out = describeProcessError(exitError(1), 'x'.repeat(5000), DIRS);
    assert.equal(out, `código 1: ${'x'.repeat(200)}…`);
});

test('sustituye antes de recortar: una ruta en el corte no deja trozos', () => {
    const stderr = `${'y'.repeat(190)} /tmp/pdfcadabra-uploads/0123456789abcdef_compressed.pdf fin`;
    const out = describeProcessError(exitError(1), stderr, DIRS);
    assert.ok(!out.includes('pdfcadabra-uploads') && !out.includes('0123456789abcdef'), out);
    assert.ok(out.endsWith('<tmp> fin'), out);
});

test('proceso matado: señal en vez de código; stderr vacío', () => {
    const killed = Object.assign(new Error('killed'), { code: null, killed: true, signal: 'SIGKILL' });
    assert.equal(describeProcessError(killed, '', DIRS), 'código SIGKILL');
    assert.equal(describeProcessError(null, undefined, DIRS), 'código desconocido');
});

test('POST /v1/compress con gs fallando: el log sigue esas reglas', async (t) => {
    childProcess.execFile = (command, args, options, callback) => {
        if (args[0] === 'lossless_images.py') {
            setImmediate(() => callback(null, '0\n', ''));
            return {};
        }
        const input = args[args.length - 1]; // gs recibe la subida al final
        setImmediate(() => callback(exitError(1), '', `**** Error leyendo ${input}\n${'z'.repeat(400)}`));
        return {};
    };
    delete require.cache[require.resolve('./server')];
    const app = require('./server');

    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.map(String).join(' '));
    t.after(() => {
        console.error = original;
    });

    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(100, 'a')], { type: 'application/pdf' }), 'expediente-secreto.pdf');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/compress`, { method: 'POST', body: form });
    await res.arrayBuffer();
    console.error = original;

    assert.equal(res.status, 500);
    const line = logged.find((l) => l.startsWith('Error en compresión:'));
    assert.ok(line, logged.join('\n'));
    assert.match(line, /^Error en compresión: código 1: \*\*\*\* Error leyendo <tmp> z+…$/);
    assert.ok(!line.includes('pdfcadabra-uploads') && !line.includes('expediente-secreto'));
    assert.ok(line.length <= 'Error en compresión: código 1: '.length + 201);
});
