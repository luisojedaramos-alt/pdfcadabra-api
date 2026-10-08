// /v1/compress lanza Ghostscript con una carpeta temporal propia dentro de
// pdfcadabra-uploads (TMPDIR/TEMP/TMP), y la borra al terminar la petición, también si
// gs muere por el tope de tiempo. Aquí gs se simula (como en compress-timeout.test.js);
// gs-killed.test.js comprueba con el gs real que sus temporales van a esa carpeta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
let gsMode = 'ok';
const gsCalls = [];

childProcess.execFile = (command, args, options, callback) => {
    // pdf_check.py verify (comprobación del resultado antes de entregarlo): todo bien.
    if (args[0] === 'pdf_check.py') {
        setImmediate(() => callback(null, '', ''));
        return {};
    }
    if (args[0] === 'lossless_images.py') {
        // protect: sin imágenes que proteger (no escribe salida).
        setImmediate(() => callback(null, '0\n', ''));
        return {};
    }
    if (command !== 'gs') {
        // jpeg_flate.py: copia la entrada tal cual.
        fs.copyFileSync(args[1], args[2]);
        setImmediate(() => callback(null, '', ''));
        return {};
    }
    const tmp = options.env && options.env.TMPDIR;
    gsCalls.push({ options, tmpExisted: !!tmp && fs.existsSync(tmp) });
    // Como el gs real: deja sus archivos de trabajo en TMPDIR.
    if (tmp) fs.writeFileSync(path.join(tmp, 'gs_simulado'), 'x');
    const out = args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
    setImmediate(() => {
        if (gsMode === 'killed') {
            return callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }), '', '');
        }
        fs.writeFileSync(out, '%PDF-1.4\n%%EOF\n');
        callback(null, '', '');
    });
    return {};
};

const app = require('./server');

async function compress(t) {
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(10000, 'a')], { type: 'application/pdf' }), 'in.pdf');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/compress`, { method: 'POST', body: form, headers: { Origin: 'https://pdfcadabra.com' } });
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 150)); // el borrado es asíncrono
    return res;
}

function assertOwnTmpDir(call) {
    const { env } = call.options;
    assert.equal(path.dirname(env.TMPDIR), UPLOAD_DIR, 'TMPDIR debe estar dentro de pdfcadabra-uploads');
    assert.match(path.basename(env.TMPDIR), /^gs-[0-9a-f-]{36}$/);
    assert.equal(env.TEMP, env.TMPDIR);
    assert.equal(env.TMP, env.TMPDIR);
    assert.equal(env.PATH, process.env.PATH, 'el resto del entorno se conserva');
    assert.equal(call.tmpExisted, true, 'la carpeta existe antes de lanzar gs');
    return env.TMPDIR;
}

test('gs recibe una carpeta temporal propia y se borra al terminar', async (t) => {
    gsMode = 'ok';
    gsCalls.length = 0;
    const res = await compress(t);
    assert.equal(res.status, 200);
    const dir = assertOwnTmpDir(gsCalls[0]);
    assert.equal(fs.existsSync(dir), false, 'la carpeta de gs debe borrarse con su contenido');
});

test('si gs muere por el tope de tiempo, su carpeta y sus temporales también se borran', async (t) => {
    gsMode = 'killed';
    gsCalls.length = 0;
    const res = await compress(t);
    assert.equal(res.status, 504);
    const dir = assertOwnTmpDir(gsCalls[0]);
    assert.equal(fs.existsSync(dir), false);
});

test('cada petición usa una carpeta distinta', async (t) => {
    gsMode = 'ok';
    gsCalls.length = 0;
    await compress(t);
    await compress(t);
    assert.notEqual(gsCalls[0].options.env.TMPDIR, gsCalls[1].options.env.TMPDIR);
});
