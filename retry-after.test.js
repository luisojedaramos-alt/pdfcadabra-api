// Retry-After en los 429 (RATE_LIMITED) y 503 (QUEUE_FULL), y expuesto por CORS para que el
// navegador pueda leerlo (Access-Control-Expose-Headers). Con 1 hueco, cola 0 y 1 petición
// a la vez por IP, una subida en curso de A llena la capacidad: la segunda de A recibe 429
// (CONCURRENT, 10 s) y B recibe 503 hasta agotar su ventana (2 peticiones), y luego 429
// (RATE, lo que quede de la ventana de 60 s). Las IPs se simulan con X-Forwarded-For.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-after-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;
process.env.HEAVY_MAX_CONCURRENT = '1';
process.env.HEAVY_MAX_QUEUE = '0';
process.env.IP_MAX_CONCURRENT = '1';
process.env.IP_MAX_PER_WINDOW = '2';
process.env.IP_WINDOW_MS = '60000';

const app = require('./server');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ORIGIN = 'https://pdfcadabra.com';
const BOUNDARY = 'limite-de-prueba';
const HEAD = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="in.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;

// Subida que envía solo el principio del multipart y se queda abierta.
function upload(port, ip) {
    const req = http.request({
        port, host: '127.0.0.1', method: 'POST', path: '/v1/compress',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
            'Content-Length': 64 * 1024,
            'X-Forwarded-For': ip,
            Origin: ORIGIN
        }
    });
    const response = new Promise((resolve, reject) => {
        req.on('response', (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
    });
    response.catch(() => {});
    req.write(HEAD);
    return { req, response };
}

async function rejected(port, ip) {
    const u = upload(port, ip);
    const res = await u.response;
    u.req.destroy();
    return res;
}

const exposed = (res) => (res.headers['access-control-expose-headers'] || '').split(',').map((h) => h.trim().toLowerCase());

test('429 y 503 llevan Retry-After en segundos y CORS lo expone', { timeout: 10000 }, async (t) => {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    t.mock.method(console, 'warn', () => {});

    const busy = upload(port, '203.0.113.7');
    await new Promise((r) => setTimeout(r, 100));

    const concurrent = await rejected(port, '203.0.113.7');
    assert.equal(concurrent.status, 429);
    assert.equal(JSON.parse(concurrent.body).code, 'RATE_LIMITED');
    assert.equal(concurrent.headers['retry-after'], '10');

    for (let i = 0; i < 2; i++) {
        const full = await rejected(port, '198.51.100.23');
        assert.equal(full.status, 503);
        assert.equal(JSON.parse(full.body).code, 'QUEUE_FULL');
        assert.equal(full.headers['retry-after'], '10');
        assert.equal(full.headers['access-control-allow-origin'], ORIGIN);
        assert.ok(exposed(full).includes('retry-after'), full.headers['access-control-expose-headers']);
    }

    // Ventana agotada (los 503 también cuentan): lo que queda de los 60 s, en segundos enteros.
    const rate = await rejected(port, '198.51.100.23');
    assert.equal(rate.status, 429);
    assert.equal(JSON.parse(rate.body).code, 'RATE_LIMITED');
    assert.match(rate.headers['retry-after'], /^\d+$/);
    const seconds = Number(rate.headers['retry-after']);
    assert.ok(seconds >= 55 && seconds <= 60, `Retry-After ${seconds}`);

    for (const res of [concurrent, rate]) {
        assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
        assert.ok(exposed(res).includes('retry-after'), res.headers['access-control-expose-headers']);
    }
    busy.req.destroy();
});
