// Errores que genera Caddy (no la API): 502 si la API no responde (p. ej. mientras se recrea el
// contenedor en un despliegue) y 413 por encima de request_body max_size. Deben llevar
// cabeceras CORS para los orígenes de la web: sin ellas el navegador no deja leer la respuesta y
// la web lo muestra como un fallo de red (estado 0, incidencia del 2026-10-15).
// Arranca un Caddy real con deploy/Caddyfile (por HTTP, en un puerto local y con la API
// sustituida por un servidor de prueba). Necesita el binario: `caddy` en el PATH o CADDY=<ruta>;
// si no está, se salta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CADDY = process.env.CADDY || 'caddy';
const hasCaddy = spawnSync(CADDY, ['version']).status === 0;
const skip = hasCaddy ? false : 'falta el binario de Caddy (CADDY=<ruta> o caddy en el PATH)';

const WEB = 'https://pdfcadabra.com';

const freePort = () => new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
    });
});

// deploy/Caddyfile tal cual, salvo la dirección del sitio (HTTP local), la de la API y el admin.
function caddyfile(port, apiPort) {
    const original = fs.readFileSync(path.join(__dirname, 'deploy', 'Caddyfile'), 'utf8');
    const adapted = original
        .replace(/^\{$/m, '{\n\tadmin off\n\tauto_https off')
        .replace('api.pdfcadabra.com {', `http://127.0.0.1:${port} {`)
        .replace('reverse_proxy api:3000', `reverse_proxy 127.0.0.1:${apiPort}`);
    assert.notEqual(adapted, original);
    return adapted;
}

async function startCaddy(t, apiPort) {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-test-'));
    const config = path.join(dir, 'Caddyfile');
    fs.writeFileSync(config, caddyfile(port, apiPort));
    const proc = spawn(CADDY, ['run', '--config', config, '--adapter', 'caddyfile'], {
        stdio: 'ignore', env: { ...process.env, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, HOME: dir, APPDATA: dir }
    });
    const exited = new Promise((r) => proc.once('exit', r));
    t.after(async () => {
        proc.kill();
        await exited; // en Windows, la carpeta no se puede borrar con Caddy en marcha
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const end = Date.now() + 10000;
    for (;;) {
        const up = await new Promise((resolve) => {
            const s = net.connect(port, '127.0.0.1', () => s.end(() => resolve(true)));
            s.on('error', () => resolve(false));
        });
        if (up) return port;
        if (Date.now() > end) assert.fail('Caddy no ha arrancado');
        await new Promise((r) => setTimeout(r, 100));
    }
}

// bodyBytes: cuerpo de ceros de ese tamaño, por bloques de 1 MB (uno por vuelta del bucle de
// eventos, para leer la respuesta en cuanto llegue).
const request = (port, { method = 'GET', origin, bodyBytes = 0 } = {}) => new Promise((resolve, reject) => {
    const headers = origin ? { Origin: origin } : {};
    if (bodyBytes) headers['Content-Length'] = bodyBytes;
    let answered = false;
    const req = http.request({ port, host: '127.0.0.1', method, path: '/v1/redact/apply', headers, agent: false }, (res) => {
        answered = true;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (err) => {
        if (!answered) reject(err);
    });
    if (!bodyBytes) return req.end();
    const block = Buffer.alloc(1024 * 1024);
    let left = bodyBytes;
    const pump = () => {
        if (answered || req.destroyed) return;
        if (left === 0) return req.end();
        const n = Math.min(left, block.length);
        left -= n;
        if (req.write(block.subarray(0, n))) setImmediate(pump);
        else req.once('drain', pump);
    };
    pump();
});

test('API caída (502): JSON con cabeceras CORS y Retry-After para la web', { skip, timeout: 20000 }, async (t) => {
    const port = await startCaddy(t, await freePort()); // nada escucha en el puerto de la API
    const res = await request(port, { method: 'POST', origin: WEB });
    assert.equal(res.status, 502);
    assert.equal(res.headers['access-control-allow-origin'], WEB);
    assert.match(res.headers['access-control-expose-headers'] || '', /Retry-After/);
    assert.equal(res.headers['retry-after'], '10');
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers.server, undefined);
    const json = JSON.parse(res.body);
    assert.equal(json.code, 'SERVICE_UNAVAILABLE');
    assert.ok(json.error);

    // Otros orígenes, sin CORS (como la API).
    const other = await request(port, { method: 'POST', origin: 'https://otro.example' });
    assert.equal(other.status, 502);
    assert.equal(other.headers['access-control-allow-origin'], undefined);
    assert.equal(other.headers.vary, 'Origin');
});

test('cuerpo por encima de request_body max_size (413): JSON con cabeceras CORS', { skip, timeout: 60000 }, async (t) => {
    // API de prueba que lee el cuerpo entero (como multer) y responde 200.
    const api = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => res.end('ok'));
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    t.after(() => api.close());
    const port = await startCaddy(t, api.address().port);

    // max_size 134MB son 134.000.000 bytes. Justo un byte más: Caddy lo lee todo y responde sin
    // dejar nada sin leer. Con más, cierra con datos pendientes y el RST puede llegar antes de que
    // el cliente lea el 413 (ECONNRESET, comprobado en Windows).
    const limit = 134000000;
    assert.equal((await request(port, { method: 'POST', origin: WEB, bodyBytes: limit })).status, 200);
    const res = await request(port, { method: 'POST', origin: WEB, bodyBytes: limit + 1 });
    assert.equal(res.status, 413);
    assert.equal(res.headers['access-control-allow-origin'], WEB);
    assert.equal(JSON.parse(res.body).error, 'FILE_TOO_LARGE');
});

test('respuesta normal de la API: pasa sin tocar (sin CORS duplicado)', { skip, timeout: 20000 }, async (t) => {
    const api = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.end('{"status":"ok"}');
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    t.after(() => api.close());
    const port = await startCaddy(t, api.address().port);

    const res = await request(port, { origin: WEB });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], WEB);
    assert.equal(res.headers['retry-after'], undefined);
    assert.equal(res.body, '{"status":"ok"}');
});
