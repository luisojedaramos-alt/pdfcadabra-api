// H2: el timeout recuperable de jpeg_flate.py conserva el hueco durante verify.
// Mismo patrón que compress-timeout.test.js: execFile simulado antes de importar
// server.js y peticiones HTTP locales. No ejecuta Python ni Ghostscript.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');
const { randomUUID } = require('crypto');

process.env.HEAVY_MAX_CONCURRENT = '1';
process.env.HEAVY_MAX_QUEUE = '5';
process.env.HEAVY_QUEUE_TIMEOUT_MS = '10000';
process.env.COMPRESS_TOTAL_TIMEOUT_MS = '90000';

const INPUT = Buffer.from('%PDF-1.4\n% entrada sintetica\n' + 'x'.repeat(10000) + '\n%%EOF\n');
const GS_OUTPUT = Buffer.from('%PDF-1.4\n% salida sintetica de GS\n%%EOF\n');
const timeoutError = () => Object.assign(new Error('timeout simulado'), { killed: true, signal: 'SIGKILL' });
let state;

childProcess.execFile = (command, args, options, callback) => {
    const stage = command === 'gs' ? 'gs' : {
        'lossless_images.py': 'protect', 'jpeg_flate.py': 'post', 'pdf_check.py': 'verify'
    }[args[0]];
    assert.ok(stage, 'solo procesos previstos de Comprimir');
    if (stage === 'protect') state.inputs.push(args[2]);
    const a = state.inputs[0];
    const isA = stage === 'gs' ? args.at(-1) === a
        : stage === 'post' ? args[1].startsWith(a + '_') : args[2] === a;
    const who = isA ? 'A' : 'B';
    state.calls.push({ who, stage });
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const finish = (error = null, stdout = '') => {
        state.active--;
        callback(error, stdout, '');
    };
    if (isA && stage === 'verify') {
        assert.ok(args[3].endsWith('_compressed_gs.pdf'), 'A reutiliza la salida GS');
        state.finishVerify = () => {
            state.finishVerify = null;
            finish(state.verifyError);
        };
        state.verifyReady();
        return {};
    }
    setImmediate(() => {
        if (stage === 'protect') return finish(null, '0\n');
        if (stage === 'gs') {
            const out = args.find(arg => arg.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
            fs.writeFileSync(out, GS_OUTPUT);
        }
        if (stage === 'post') {
            if (isA) return finish(timeoutError());
            fs.copyFileSync(args[1], args[2]);
        }
        finish();
    });
    return {};
};

const app = require('./server');

for (const outcome of ['éxito', 'error', 'timeout']) {
    test(`H2: retiene el slot durante verify (${outcome}) y lo libera para B`, { timeout: 10000 }, async (t) => {
        let ready;
        const verifyReady = new Promise(resolve => { ready = resolve; });
        state = {
            inputs: [], calls: [], active: 0, maxActive: 0, verifyReady: ready,
            verifyError: outcome === 'éxito' ? null : outcome === 'timeout' ? timeoutError() : new Error('verify inválido')
        };
        const server = app.listen(0, '127.0.0.1');
        const requests = [];
        t.after(async () => {
            // Desbloquea también el escenario defectuoso si falla una aserción.
            if (state.finishVerify) state.finishVerify();
            server.closeAllConnections();
            await Promise.allSettled(requests);
            await new Promise(resolve => server.close(resolve));
        });
        await new Promise(resolve => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const status = async id => {
            const res = await fetch(`${base}/v1/queue/status/${id}`, { signal: t.signal });
            assert.equal(res.status, 200);
            return res.json();
        };
        const compress = id => {
            const form = new FormData();
            form.append('file', new Blob([INPUT], { type: 'application/pdf' }), 'synthetic.pdf');
            form.append('level', 'recommended');
            const request = fetch(`${base}/v1/compress`, {
                method: 'POST', body: form, headers: { 'X-Request-Id': id, Origin: 'https://pdfcadabra.com' }, signal: t.signal
            }).then(async res => ({ res, body: Buffer.from(await res.arrayBuffer()) }));
            requests.push(request);
            request.catch(() => {}); // el timeout del test puede abortar las peticiones
            return request;
        };
        const a = randomUUID(), b = randomUUID();
        const responseA = compress(a);
        await verifyReady;
        const responseB = compress(b);
        // Espera a la llegada de B al gate, sin depender de una pausa fija.
        let bStatus;
        do {
            bStatus = await status(b);
            if (state.calls.some(call => call.who === 'B')) break;
        } while (bStatus.state === 'unknown');

        assert.deepEqual(await status(a), { state: 'running' });
        assert.deepEqual(bStatus, { state: 'queued', position: 1 });
        assert.equal(state.calls.some(call => call.who === 'B'), false, 'B no inicia trabajo durante verify A');
        assert.equal(state.active, 1);
        assert.equal(state.maxActive, 1);

        state.finishVerify();
        const [resultA, resultB] = await Promise.all([responseA, responseB]);
        assert.equal(resultA.res.status, 200);
        assert.deepEqual(resultA.body, outcome === 'éxito' ? GS_OUTPUT : INPUT);
        assert.equal(resultA.res.headers.get('x-compress-status'), outcome === 'éxito' ? 'compressed' : 'already-optimized');
        assert.equal(resultB.res.status, 200);
        assert.deepEqual(resultB.body, GS_OUTPUT);
        assert.ok(state.calls.some(call => call.who === 'B' && call.stage === 'protect'), 'B avanza al terminar A');
        assert.equal(state.active, 0);
        assert.equal(state.maxActive, 1);
        assert.deepEqual(await status(a), { state: 'unknown' });
        assert.deepEqual(await status(b), { state: 'unknown' });
    });
}
