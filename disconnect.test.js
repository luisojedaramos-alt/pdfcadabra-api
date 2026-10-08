// Cliente desconectado con un proceso pesado en marcha: se mata el proceso (SIGKILL), no se
// lanza el siguiente paso de la cadena (jpeg_flate.py tras gs), se libera el hueco y se
// borran los temporales, también los que el proceso escribe y ya no puede borrar.
// gs y python se sustituyen por procesos reales de node que escriben sus archivos y no
// terminan nunca: así se comprueba que de verdad mueren (sin huérfanos), no solo que se
// llama a kill. execFile se sustituye antes de cargar server.js, como en los demás tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { randomUUID } = require('crypto');

process.env.HEAVY_MAX_CONCURRENT = '1';
process.env.HEAVY_MAX_QUEUE = '5';

const realExecFile = childProcess.execFile;
const UPLOAD_DIR = path.join(os.tmpdir(), 'pdfcadabra-uploads');
// Proceso que crea los archivos que recibe y se queda colgado (como un gs o un redact.py lentos).
const HANG = "for (const f of process.argv.slice(1)) require('fs').writeFileSync(f, 'x'); setInterval(() => {}, 1000);";

let launched;   // [{ stage, child, files }]
let onLaunch;   // avisa al test de que se ha lanzado un proceso

childProcess.execFile = (command, args, options, callback) => {
    const stage = command === 'gs' ? 'gs' : args[0];
    let files = [];
    if (stage === 'lossless_images.py') {
        // protect sin imágenes que proteger: termina al momento.
        setImmediate(() => callback(null, '0\n', ''));
        launched.push({ stage });
        return { kill() {} };
    }
    if (stage === 'gs') {
        // Su salida y un archivo de trabajo en su carpeta (TMPDIR).
        files = [args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length),
            path.join(options.env.TMPDIR, 'gs_trabajo')];
    } else if (stage === 'redact.py' && args[1] === 'apply') {
        // python3 redact.py apply <entrada> <salida> <hallazgos> <informe>: la salida y las
        // copias de trabajo de las capas OCG, que redact.py solo borra si termina.
        files = [args[3], `${args[3]}.pre.pdf`, `${args[3]}.pre.pdf.capas.pdf`, `${args[3]}.capas.pdf`];
    } else if (stage === 'redact.py') {
        files = [args[4]]; // search: el archivo de resultados
    }
    const child = realExecFile(process.execPath, ['-e', HANG, ...files], options, callback);
    const entry = { stage, child, files, args };
    launched.push(entry);
    onLaunch(entry);
    return child;
};

const app = require('./server');

const isAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

async function waitFor(check, what, ms = 5000) {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) assert.fail(`tiempo agotado esperando: ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

const ROUTES = {
    '/v1/compress': { stage: 'gs', fields: { level: 'extreme' } },
    '/v1/redact/search': { stage: 'redact.py', fields: { patterns: JSON.stringify([{ type: 'text', value: 'x' }]) } },
    '/v1/redact/apply': { stage: 'redact.py', fields: { items: JSON.stringify([{ id: 'a', page: 0, rect: [0, 0, 10, 10] }]) } }
};

for (const [route, { stage, fields }] of Object.entries(ROUTES)) {
    test(`${route}: al desconectarse el cliente, el proceso muere, se libera el hueco y no quedan archivos`, { timeout: 20000 }, async (t) => {
        launched = [];
        const server = app.listen(0, '127.0.0.1');
        t.after(() => {
            for (const { child } of launched) if (child) child.kill('SIGKILL');
            server.closeAllConnections();
            server.close();
        });
        await new Promise((r) => server.once('listening', r));
        const base = `http://127.0.0.1:${server.address().port}`;

        const id = randomUUID();
        const started = new Promise((resolve) => { onLaunch = (e) => { if (e.stage === stage) resolve(e); }; });
        const controller = new AbortController();
        const form = new FormData();
        form.append('file', new Blob([Buffer.from('%PDF-1.4 entrada')], { type: 'application/pdf' }), 'in.pdf');
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        const request = fetch(`${base}${route}`, {
            method: 'POST', body: form, headers: { 'X-Request-Id': id }, signal: controller.signal
        });
        request.catch(() => {});

        const entry = await started;
        // Espera a que el proceso haya escrito sus archivos: deben borrarse aunque no los borre él.
        await waitFor(() => entry.files.every((f) => fs.existsSync(f)), 'archivos del proceso');
        const status = await (await fetch(`${base}/v1/queue/status/${id}`)).json();
        assert.deepEqual(status, { state: 'running' });

        const warn = t.mock.method(console, 'warn', () => {});
        controller.abort();

        await waitFor(() => entry.child.exitCode !== null || entry.child.signalCode !== null, 'que el proceso muera');
        assert.equal(entry.child.killed, true, 'se le manda SIGKILL');
        assert.equal(isAlive(entry.child.pid), false, 'no queda vivo');
        assert.ok(warn.mock.calls.some((c) => /Cliente desconectado: 1 proceso/.test(c.arguments[0])));

        // Ni jpeg_flate.py ni verify después de gs: la cadena se corta.
        assert.deepEqual(launched.filter((e) => e.stage !== 'lossless_images.py').map((e) => e.stage), [stage]);
        assert.deepEqual(await (await fetch(`${base}/v1/queue/status/${id}`)).json(), { state: 'unknown' });

        // Temporales: la subida, lo que escribió el proceso y, en Comprimir, la carpeta de gs.
        const inputPath = route === '/v1/compress' ? entry.args.at(-1) : entry.args[2];
        const leftovers = [inputPath, ...entry.files];
        if (stage === 'gs') leftovers.push(path.dirname(entry.files[1]));
        await waitFor(() => leftovers.every((f) => !fs.existsSync(f)), `borrar ${leftovers.map((f) => path.relative(UPLOAD_DIR, f)).join(', ')}`);

        // El hueco está libre: la siguiente petición arranca su proceso.
        const next = new Promise((resolve) => { onLaunch = (e) => { if (e.stage === stage) resolve(e); }; });
        const controller2 = new AbortController();
        const form2 = new FormData();
        form2.append('file', new Blob([Buffer.from('%PDF-1.4 otra')], { type: 'application/pdf' }), 'in.pdf');
        for (const [k, v] of Object.entries(fields)) form2.append(k, v);
        fetch(`${base}${route}`, { method: 'POST', body: form2, signal: controller2.signal }).catch(() => {});
        const second = await next;
        controller2.abort();
        await waitFor(() => second.child.exitCode !== null || second.child.signalCode !== null, 'que muera el segundo');
    });
}
