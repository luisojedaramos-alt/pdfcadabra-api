// Origin obligatorio en los POST de /v1/*: sin Origin o con uno ajeno, 403 en JSON sin
// llegar a multer ni a la cola; con uno permitido pasa. El preflight y los GET no cambian.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

process.env.NODE_ENV = 'production';

// Ningún POST rechazado debe lanzar procesos; los permitidos de este test tampoco llegan
// (van sin archivo: 400 de la ruta).
childProcess.execFile = () => assert.fail('no debe lanzarse ningún proceso');

const app = require('./server');

async function listen(t) {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    return `http://127.0.0.1:${server.address().port}`;
}

const ROUTES = ['/v1/compress', '/v1/redact/search', '/v1/redact/apply'];

test('POST sin Origin o con uno ajeno: 403 ORIGIN_NOT_ALLOWED', async (t) => {
    const base = await listen(t);
    const warn = t.mock.method(console, 'warn', () => {});
    for (const route of ROUTES) {
        for (const headers of [{}, { Origin: 'https://otro.example.com' }, { Origin: 'http://localhost:5173' }, { Origin: 'null' }]) {
            const form = new FormData();
            form.append('file', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'in.pdf');
            const res = await fetch(`${base}${route}`, { method: 'POST', body: form, headers });
            assert.equal(res.status, 403, `${route} ${JSON.stringify(headers)}`);
            assert.deepEqual(await res.json(), { code: 'ORIGIN_NOT_ALLOWED', error: 'Origen no permitido.' });
            assert.equal(res.headers.get('access-control-allow-origin'), null);
        }
    }
    assert.equal(warn.mock.callCount(), ROUTES.length * 4);
});

test('POST con un Origin permitido: pasa a la ruta (aquí, 400 por faltar el archivo)', async (t) => {
    const base = await listen(t);
    for (const route of ROUTES) {
        const res = await fetch(`${base}${route}`, {
            method: 'POST', body: new FormData(), headers: { Origin: 'https://www.pdfcadabra.com' }
        });
        assert.equal(res.status, 400, route);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://www.pdfcadabra.com');
    }
});

test('el preflight y los GET no exigen Origin', async (t) => {
    const base = await listen(t);
    const preflight = await fetch(`${base}/v1/compress`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://pdfcadabra.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-request-id' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://pdfcadabra.com');
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const status = await fetch(`${base}/v1/queue/status/00000000-0000-0000-0000-000000000000`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { state: 'unknown' });
});
