// Parada ordenada (SIGTERM, el que manda `docker compose up -d` al recrear el contenedor): el
// servidor deja de aceptar conexiones, termina las peticiones en curso y solo entonces sale.
// Antes, node (PID 1 en el contenedor, sin manejador) ignoraba SIGTERM, Docker lo mataba con
// SIGKILL a los 10 s y una censura en marcha acababa en un 502 de Caddy sin cabeceras CORS
// (estado 0 en la web). redact.py se sustituye por un proceso falso que espera a que el test lo
// suelte; la señal se simula con process.emit (en Windows no se puede enviar SIGTERM de verdad).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const childProcess = require('child_process');

let pending = []; // callbacks de los redact.py falsos en marcha
childProcess.execFile = (command, args, options, callback) => {
    // python3 redact.py apply <entrada> <salida> <hallazgos> <informe>
    const [, , , output, , report] = args;
    pending.push(() => {
        fs.writeFileSync(output, '%PDF-1.4 censurado');
        fs.writeFileSync(report, JSON.stringify({ verified: true, applied: 1, failed: [] }));
        callback(null, '', '');
    });
    return { kill() {} };
};

const app = require('./server');

const ORIGIN = 'https://pdfcadabra.com';
const BOUNDARY = 'limite-de-prueba';

// /v1/redact/apply por una conexión keep-alive, como las que Caddy mantiene con la API.
function apply(port, agent) {
    const body = Buffer.from([
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="items"',
        '',
        JSON.stringify([{ id: 'a', page: 0, rect: [0, 0, 10, 10] }]),
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="file"; filename="a.pdf"',
        'Content-Type: application/pdf',
        '',
        '%PDF-1.4 original',
        `--${BOUNDARY}--`,
        ''
    ].join('\r\n'));
    return new Promise((resolve, reject) => {
        const req = http.request({
            port, method: 'POST', path: '/v1/redact/apply', agent,
            headers: {
                Origin: ORIGIN,
                'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
                'Content-Length': body.length
            }
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

async function waitFor(check, what, ms = 5000) {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) assert.fail(`tiempo agotado esperando: ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

// Conexión nueva: true si el servidor la acepta.
const accepts = (port) => new Promise((resolve) => {
    const req = http.get({ port, path: '/health', agent: false }, (res) => {
        res.resume();
        resolve(true);
    });
    req.on('error', () => resolve(false));
});

async function start(t, graceMs) {
    pending = [];
    const exits = [];
    const server = app.startServer(0, undefined, { shutdown: { exit: (code) => exits.push(code), graceMs } });
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    await new Promise((r) => server.once('listening', r));
    return { server, port: server.address().port, exits };
}

test('SIGTERM con una censura en marcha: no acepta conexiones nuevas, la termina y sale con 0', { timeout: 15000 }, async (t) => {
    t.mock.method(console, 'log', () => {});
    const { port, exits } = await start(t, 10000);
    const agent = new http.Agent({ keepAlive: true });
    t.after(() => agent.destroy());

    const inFlight = apply(port, agent);
    await waitFor(() => pending.length === 1, 'redact.py en marcha');

    process.emit('SIGTERM');
    assert.equal(await accepts(port), false, 'tras SIGTERM no debe aceptar conexiones nuevas');
    assert.deepEqual(exits, [], 'no debe salir con una petición en curso');

    pending.shift()();
    const res = await inFlight;
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(res.body, '%PDF-1.4 censurado');
    // La conexión keep-alive (la de Caddy) no debe retener la salida.
    await waitFor(() => exits.length > 0, 'salida del proceso');
    assert.deepEqual(exits, [0]);
});

test('SIGTERM: si una petición no termina en el plazo de gracia, sale con 1', { timeout: 15000 }, async (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    const { port, exits } = await start(t, 300);

    apply(port, false).catch(() => {});
    await waitFor(() => pending.length === 1, 'redact.py en marcha');

    process.emit('SIGTERM');
    await waitFor(() => exits.length > 0, 'salida forzada');
    assert.deepEqual(exits, [1]);
});
