// Niveles de /v1/compress: argumentos de Ghostscript (JPEG forzado en recomendada y
// extrema, B/N siempre sin pérdida) y red de seguridad con el nivel low cuando el nivel
// pedido no reduce al menos un 2 %. gs y jpeg_flate.py se simulan sustituyendo execFile
// antes de cargar server.js (como en compress-timeout.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const childProcess = require('child_process');

const INPUT = Buffer.alloc(10000, 'a');
// Tamaño de la salida de gs según el preset (null = gs muere por el tope de tiempo).
let gsSizes = {};
const calls = [];

childProcess.execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    if (command !== 'gs') {
        // jpeg_flate.py: copia la entrada tal cual.
        fs.copyFileSync(args[1], args[2]);
        setImmediate(() => callback(null, '', ''));
        return {};
    }
    const preset = args.find((a) => a.startsWith('-dPDFSETTINGS=')).slice('-dPDFSETTINGS='.length);
    const out = args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
    setImmediate(() => {
        const size = gsSizes[preset];
        if (size === null) {
            return callback(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }), '', '');
        }
        fs.writeFileSync(out, Buffer.alloc(size, 'b'));
        callback(null, '', '');
    });
    return {};
};

const app = require('./server');
const { compressArgs, COMPRESS_LEVELS } = app;

async function compress(t, level) {
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const form = new FormData();
    form.append('file', new Blob([INPUT], { type: 'application/pdf' }), 'in.pdf');
    form.append('level', level);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/compress`, { method: 'POST', body: form });
    const body = Buffer.from(await res.arrayBuffer());
    await new Promise((r) => setTimeout(r, 150)); // el borrado es asíncrono
    return { res, body };
}

const gsPresets = () => calls.filter((c) => c.command === 'gs').map((c) => c.args.find((a) => a.startsWith('-dPDFSETTINGS=')));
const outputs = () => calls.flatMap((c) => (c.command === 'gs'
    ? [c.args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length)]
    : [c.args[2]]));

test('recomendada: color y gris a 150 ppp con Bicubic en JPEG calidad ~65, B/N sin pérdida', () => {
    const args = compressArgs(COMPRESS_LEVELS.recommended, 'in.pdf', 'out.pdf');
    for (const a of [
        '-dPDFSETTINGS=/ebook',
        '-dColorImageResolution=150', '-dColorImageDownsampleThreshold=1',
        '-dGrayImageResolution=150', '-dGrayImageDownsampleThreshold=1',
        '-dColorImageDownsampleType=/Bicubic', '-dGrayImageDownsampleType=/Bicubic',
        '-dAutoFilterColorImages=false', '-dColorImageFilter=/DCTEncode',
        '-dAutoFilterGrayImages=false', '-dGrayImageFilter=/DCTEncode',
        '-dPassThroughJPEGImages=false',
        '-dMonoImageResolution=200', '-dMonoImageFilter=/CCITTFaxEncode', '-dMonoImageDownsampleType=/Subsample'
    ]) assert.ok(args.includes(a), `falta ${a}`);
    const ps = args[args.indexOf('-c') + 1];
    assert.match(ps, /\/ColorImageDict << \/QFactor 0\.7 /);
    assert.match(ps, /\/GrayImageDict << \/QFactor 0\.7 /);
    assert.deepEqual(args.slice(-2), ['-f', 'in.pdf'], 'la entrada va después de -f');
    assert.ok(!args.some((a) => /Mono.*DCT|JBIG2/i.test(a)), 'B/N nunca con pérdida');
});

test('extrema: 100 ppp con Bicubic, JPEG calidad ~60 (QFactor 0.8), B/N a 150 sin pérdida', () => {
    const args = compressArgs(COMPRESS_LEVELS.extreme, 'in.pdf', 'out.pdf');
    assert.ok(args.includes('-dPDFSETTINGS=/screen'));
    assert.ok(args.includes('-dColorImageResolution=100'));
    assert.ok(args.includes('-dGrayImageResolution=100'));
    assert.ok(args.includes('-dColorImageDownsampleType=/Bicubic'));
    assert.ok(args.includes('-dGrayImageDownsampleType=/Bicubic'));
    assert.ok(args.includes('-dMonoImageResolution=150'));
    assert.match(args[args.indexOf('-c') + 1], /\/QFactor 0\.8 /);
    assert.ok(args.includes('-dMonoImageFilter=/CCITTFaxEncode'));
});

test('baja: sin cambios (ni reducción ni JPEG forzado)', () => {
    const args = compressArgs(COMPRESS_LEVELS.low, 'in.pdf', 'out.pdf');
    assert.ok(args.includes('-dDownsampleColorImages=false'));
    assert.ok(args.includes('-dDownsampleMonoImages=false'));
    assert.ok(args.includes('-dColorImageDownsampleType=/Bicubic'), 'Bicubic también en baja (no reduce, pero es uniforme)');
    assert.ok(!args.includes('-c'));
    assert.ok(!args.some((a) => a.includes('DCTEncode') || a.includes('PassThroughJPEG')));
    assert.equal(args.at(-1), 'in.pdf');
});

test('si el nivel pedido reduce, no hay red de seguridad', async (t) => {
    calls.length = 0;
    gsSizes = { '/ebook': 4000, '/printer': 3000 };
    const { res, body } = await compress(t, 'recommended');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-compress-status'), 'compressed');
    assert.equal(res.headers.get('x-compress-level'), 'recommended');
    assert.equal(body.length, 4000);
    assert.deepEqual(gsPresets(), ['-dPDFSETTINGS=/ebook']);
});

test('si recomendada no reduce, se reintenta con low y se indica en la cabecera', async (t) => {
    calls.length = 0;
    gsSizes = { '/ebook': 15000, '/printer': 6000 };
    const { res, body } = await compress(t, 'recommended');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-compress-status'), 'compressed');
    assert.equal(res.headers.get('x-compress-level'), 'low');
    assert.equal(body.length, 6000);
    assert.deepEqual(gsPresets(), ['-dPDFSETTINGS=/ebook', '-dPDFSETTINGS=/printer']);
    // Los procesos de la red de seguridad comparten el tope: nunca más que el total.
    const [first, second] = calls.filter((c) => c.command === 'gs');
    assert.ok(second.options.timeout <= first.options.timeout);
    for (const f of outputs()) assert.equal(fs.existsSync(f), false, `${f} debe borrarse`);
});

test('extrema con un ahorro menor del 2 % también activa la red de seguridad', async (t) => {
    calls.length = 0;
    gsSizes = { '/screen': 9900, '/printer': 5000 };
    const { res } = await compress(t, 'extreme');
    assert.equal(res.headers.get('x-compress-level'), 'low');
    assert.deepEqual(gsPresets(), ['-dPDFSETTINGS=/screen', '-dPDFSETTINGS=/printer']);
});

test('si tampoco low reduce, se devuelve el original', async (t) => {
    calls.length = 0;
    gsSizes = { '/ebook': 15000, '/printer': 12000 };
    const { res, body } = await compress(t, 'recommended');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-compress-status'), 'already-optimized');
    assert.equal(res.headers.get('x-compress-level'), 'none');
    assert.deepEqual(body, INPUT);
});

test('si la red de seguridad se queda sin tiempo, se devuelve el original (no un 504)', async (t) => {
    calls.length = 0;
    gsSizes = { '/ebook': 15000, '/printer': null };
    const { res, body } = await compress(t, 'recommended');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-compress-status'), 'already-optimized');
    assert.equal(res.headers.get('x-compress-level'), 'none');
    assert.deepEqual(body, INPUT);
});

test('si gs agota el tope en el nivel pedido, 504 (sin red de seguridad)', async (t) => {
    calls.length = 0;
    gsSizes = { '/ebook': null, '/printer': 1000 };
    const { res } = await compress(t, 'recommended');
    assert.equal(res.status, 504);
    assert.deepEqual(gsPresets(), ['-dPDFSETTINGS=/ebook']);
});

test('low sin ahorro: el original, sin segunda pasada', async (t) => {
    calls.length = 0;
    gsSizes = { '/printer': 12000 };
    const { res } = await compress(t, 'low');
    assert.equal(res.headers.get('x-compress-status'), 'already-optimized');
    assert.deepEqual(gsPresets(), ['-dPDFSETTINGS=/printer']);
});

test('X-Compress-Level se expone por CORS', async (t) => {
    calls.length = 0;
    gsSizes = { '/ebook': 4000 };
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const form = new FormData();
    form.append('file', new Blob([INPUT], { type: 'application/pdf' }), 'in.pdf');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/compress`, {
        method: 'POST', body: form, headers: { Origin: 'https://pdfcadabra.com' }
    });
    await res.arrayBuffer();
    assert.match(res.headers.get('access-control-expose-headers'), /X-Compress-Level/);
});
