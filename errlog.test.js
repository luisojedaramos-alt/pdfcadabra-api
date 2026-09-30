const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { describeError } = require('./errlog');
const app = require('./server');

const SECRET = 'DNI 12345678Z juicio ordinario 123/2026';

test('solo código y mensaje: nada de stack ni propiedades extra', () => {
    const err = Object.assign(new Error('fallo'), { code: 'EFALLO', body: SECRET, headers: { cookie: SECRET } });
    const out = describeError(err);
    assert.equal(out, '[EFALLO] fallo');
    assert.ok(!out.includes(SECRET));
    assert.ok(!out.includes('at '), 'sin stack trace');
});

test('sin code usa el tipo o el nombre del error', () => {
    assert.equal(describeError(new TypeError('x')), '[TypeError] x');
    assert.equal(describeError(Object.assign(new Error('y'), { type: 'entity.too.large' })), '[entity.too.large] y');
});

test('errores de fs: código y mensaje', () => {
    let err;
    try {
        fs.readFileSync('/no/existe/pdfcadabra.pdf');
    } catch (e) {
        err = e;
    }
    assert.match(describeError(err), /^\[ENOENT\] ENOENT: no such file or directory/);
});

test('valores que no son objetos', () => {
    assert.equal(describeError('texto'), 'texto');
    assert.equal(describeError(undefined), 'undefined');
    assert.equal(describeError(null), 'null');
});

test('un JSON mal formado no deja el cuerpo en el log ni en la respuesta', async (t) => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.map(String).join(' '));
    t.after(() => {
        console.error = original;
    });

    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/redact/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"patterns": ${SECRET}`
    });
    const body = await res.text();
    console.error = original;

    assert.equal(res.status, 400);
    assert.ok(!body.includes(SECRET), 'la respuesta no cita el cuerpo');
    assert.ok(logged.some((l) => l.includes('Error no gestionado') && l.includes('entity.parse.failed')), logged.join('\n'));
    assert.ok(!logged.join('\n').includes('12345678Z'), 'el log no cita el cuerpo');
});
