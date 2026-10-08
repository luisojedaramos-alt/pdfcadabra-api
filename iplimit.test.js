// Límite por cliente (iplimit.js y su uso en server.js): la cuarta petición simultánea de
// una IP recibe 429, otra IP pasa, la ventana caduca, y ninguna IP queda en memoria ni en
// el log. Sin Caddy delante, el test simula las IPs con X-Forwarded-For (trust proxy = 1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');
const { createIpLimiter } = require('./iplimit');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iplimit-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = TMP;
process.env.HEAVY_MAX_CONCURRENT = '5';
process.env.HEAVY_MAX_QUEUE = '5';
process.env.IP_MAX_CONCURRENT = '3';
process.env.IP_MAX_PER_WINDOW = '6';
process.env.IP_WINDOW_MS = '1500';

// Comprimir simulado que termina al momento.
childProcess.execFile = (command, args, options, callback) => {
    if (command === 'gs') {
        const out = args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
        fs.writeFileSync(out, '%PDF-1.4\n%%EOF\n');
    }
    if (args[0] === 'jpeg_flate.py') fs.copyFileSync(args[1], args[2]);
    setImmediate(() => callback(null, args[0] === 'lossless_images.py' ? '0\n' : '', ''));
    return { kill() {} };
};

const app = require('./server');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const IP_A = '203.0.113.7';
const IP_B = '198.51.100.23';
const BOUNDARY = 'limite-de-prueba';
const HEAD = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="in.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
const TAIL = `\r\n--${BOUNDARY}--\r\n`;
const FILE = 'x'.repeat(2048);

// Subida desde `ip` que envía solo la cabecera del multipart y espera a `finish()`.
function upload(port, ip) {
    const req = http.request({
        port, host: '127.0.0.1', method: 'POST', path: '/v1/compress',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
            'Content-Length': Buffer.byteLength(HEAD + FILE + TAIL),
            'X-Forwarded-For': ip,
            Origin: 'https://pdfcadabra.com'
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
    return { req, response, finish: () => req.end(FILE + TAIL) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('HTTP: 4.ª simultánea de una IP 429, otra IP pasa, ventana por IP y nada de IPs en el log', { timeout: 20000 }, async (t) => {
    const server = app.listen(0, '127.0.0.1');
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();

    const logged = [];
    for (const level of ['log', 'warn', 'error', 'info']) {
        t.mock.method(console, level, (...args) => logged.push(args.map(String).join(' ')));
    }

    // Tres subidas de A en curso: la cuarta recibe 429 sin enviar el cuerpo.
    const a = [upload(port, IP_A), upload(port, IP_A), upload(port, IP_A)];
    await wait(100);
    const fourth = upload(port, IP_A);
    const rejected = await fourth.response;
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers['retry-after'], '10');
    assert.equal(rejected.headers.connection, 'close');
    assert.equal(JSON.parse(rejected.body).code, 'RATE_LIMITED');
    fourth.req.destroy();

    // Otra IP pasa a la vez.
    const b = upload(port, IP_B);
    b.finish();
    assert.equal((await b.response).status, 200);

    // A termina las tres: vuelve a tener sitio (lleva 3 de 6 en la ventana).
    for (const u of a) u.finish();
    for (const u of a) assert.equal((await u.response).status, 200);
    for (let i = 0; i < 3; i++) {
        const u = upload(port, IP_A);
        u.finish();
        assert.equal((await u.response).status, 200);
    }
    // La 7.ª de la ventana: 429 con Retry-After hasta que caduque.
    const seventh = upload(port, IP_A);
    const limited = await seventh.response;
    seventh.req.destroy();
    assert.equal(limited.status, 429);
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(retryAfter >= 1 && retryAfter <= 2, `Retry-After ${retryAfter}`);

    // Caducada la ventana, A vuelve a pasar.
    await wait(1600);
    const again = upload(port, IP_A);
    again.finish();
    assert.equal((await again.response).status, 200);

    const all = logged.join('\n');
    assert.ok(all.includes('Límite por cliente (CONCURRENT)'), all);
    assert.ok(all.includes('Límite por cliente (RATE)'), all);
    for (const ip of [IP_A, IP_B, '127.0.0.1']) assert.ok(!all.includes(ip), `el log no cita ${ip}`);
});

test('iplimit: claves sin la IP, liberar es idempotente y se purga al caducar la ventana', () => {
    let t = 0;
    const limiter = createIpLimiter({ maxConcurrent: 2, maxPerWindow: 3, windowMs: 1000, now: () => t });
    try {
        const s1 = limiter.acquire(IP_A);
        const s2 = limiter.acquire(IP_A);
        assert.deepEqual(limiter.acquire(IP_A), { ok: false, reason: 'CONCURRENT', retryAfterS: 10 });
        const b1 = limiter.acquire(IP_B);
        assert.equal(b1.ok, true);
        assert.equal(limiter.size(), 2);
        for (const key of limiter.keys()) {
            assert.ok(!key.includes(IP_A) && !key.includes(IP_B), 'la clave no contiene la IP');
        }

        s1.release();
        s1.release(); // idempotente: no libera dos huecos
        const s3 = limiter.acquire(IP_A); // 3.ª de la ventana
        assert.equal(s3.ok, true);
        assert.equal(limiter.acquire(IP_A).reason, 'CONCURRENT', 's2 y s3 siguen en curso');
        s2.release();
        s3.release();
        t = 400;
        assert.deepEqual(limiter.acquire(IP_A), { ok: false, reason: 'RATE', retryAfterS: 1 });

        // Ventana caducada: se purga A (nada en curso), no B (b1 sigue en curso).
        t = 1000;
        limiter.purge();
        assert.equal(limiter.size(), 1);
        b1.release();
        t = 2000;
        limiter.purge();
        assert.equal(limiter.size(), 0);

        // Nueva ventana: A vuelve a pasar.
        assert.equal(limiter.acquire(IP_A).ok, true);
    } finally {
        limiter.stop();
    }
});
