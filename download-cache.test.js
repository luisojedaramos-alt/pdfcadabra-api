// Las descargas (/v1/compress y /v1/redact/apply) son documentos del usuario: Cache-Control:
// no-store y sin ETag ni Last-Modified. Antes res.sendFile ponía sus valores por defecto
// (`public, max-age=0`, ETag y Last-Modified), que dejaban guardarlas en cachés intermedias o del
// navegador. gs, jpeg_flate.py, pdf_check.py y redact.py se simulan sustituyendo execFile antes
// de cargar server.js (como en compress-levels.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');

const INPUT = Buffer.alloc(10000, 'a');
let gsSize = 5000; // tamaño de la salida de gs: 5000 comprime; 10000 devuelve el original

childProcess.execFile = (command, args, options, callback) => {
    if (command === 'gs') {
        const out = args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
        fs.writeFileSync(out, Buffer.alloc(gsSize, 'b'));
    } else if (args[0] === 'lossless_images.py') {
        setImmediate(() => callback(null, '0\n', ''));
        return {};
    } else if (args[0] === 'jpeg_flate.py') {
        fs.copyFileSync(args[1], args[2]);
    } else if (args[0] === 'redact.py') {
        // python3 redact.py apply <entrada> <salida> <hallazgos> <informe>
        fs.writeFileSync(args[3], '%PDF-1.4 censurado');
        fs.writeFileSync(args[5], JSON.stringify({ verified: true, applied: 1, failed: [] }));
    }
    // pdf_check.py verify: bien.
    setImmediate(() => callback(null, '', ''));
    return {};
};

const app = require('./server');

async function post(t, route, fields) {
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const form = new FormData();
    form.append('file', new Blob([INPUT], { type: 'application/pdf' }), 'in.pdf');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method: 'POST', body: form, headers: { Origin: 'https://pdfcadabra.com' }
    });
    const body = Buffer.from(await res.arrayBuffer());
    await new Promise((r) => setTimeout(r, 150)); // el borrado es asíncrono
    return { res, body };
}

function assertNoCache(res) {
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('etag'), null);
    assert.equal(res.headers.get('last-modified'), null);
}

test('/v1/compress (comprimido): no-store, sin ETag ni Last-Modified', async (t) => {
    gsSize = 5000;
    const { res, body } = await post(t, '/v1/compress', { level: 'recommended' });
    assertNoCache(res);
    assert.equal(res.headers.get('x-compress-status'), 'compressed');
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(body.length, 5000);
});

test('/v1/compress (original sin tocar): no-store, sin ETag ni Last-Modified', async (t) => {
    gsSize = 10000;
    const { res, body } = await post(t, '/v1/compress', { level: 'low' });
    assertNoCache(res);
    assert.equal(res.headers.get('x-compress-status'), 'already-optimized');
    assert.deepEqual(body, INPUT);
});

test('/v1/redact/apply: no-store, sin ETag ni Last-Modified', async (t) => {
    const { res, body } = await post(t, '/v1/redact/apply', {
        items: JSON.stringify([{ id: 'a', page: 0, rect: [0, 0, 10, 10] }])
    });
    assertNoCache(res);
    assert.equal(body.toString(), '%PDF-1.4 censurado');
});
