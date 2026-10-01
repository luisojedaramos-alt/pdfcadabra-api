// Niveles de /v1/compress: argumentos de Ghostscript (JPEG forzado en recomendada y
// extrema, B/N siempre sin pérdida).
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

test('recomendada: color y gris a 150 ppp en JPEG calidad ~75, B/N sin pérdida', () => {
    const args = compressArgs(COMPRESS_LEVELS.recommended, 'in.pdf', 'out.pdf');
    for (const a of [
        '-dPDFSETTINGS=/ebook',
        '-dColorImageResolution=150', '-dColorImageDownsampleThreshold=1',
        '-dGrayImageResolution=150', '-dGrayImageDownsampleThreshold=1',
        '-dAutoFilterColorImages=false', '-dColorImageFilter=/DCTEncode',
        '-dAutoFilterGrayImages=false', '-dGrayImageFilter=/DCTEncode',
        '-dPassThroughJPEGImages=false',
        '-dMonoImageResolution=200', '-dMonoImageFilter=/CCITTFaxEncode', '-dMonoImageDownsampleType=/Subsample'
    ]) assert.ok(args.includes(a), `falta ${a}`);
    const ps = args[args.indexOf('-c') + 1];
    assert.match(ps, /\/ColorImageDict << \/QFactor 0\.5 /);
    assert.match(ps, /\/GrayImageDict << \/QFactor 0\.5 /);
    assert.deepEqual(args.slice(-2), ['-f', 'in.pdf'], 'la entrada va después de -f');
    assert.ok(!args.some((a) => /Mono.*DCT|JBIG2/i.test(a)), 'B/N nunca con pérdida');
});

test('extrema: 110 ppp, JPEG calidad ~60 (QFactor 0.8), B/N a 150 sin pérdida', () => {
    const args = compressArgs(COMPRESS_LEVELS.extreme, 'in.pdf', 'out.pdf');
    assert.ok(args.includes('-dPDFSETTINGS=/screen'));
    assert.ok(args.includes('-dColorImageResolution=110'));
    assert.ok(args.includes('-dMonoImageResolution=150'));
    assert.match(args[args.indexOf('-c') + 1], /\/QFactor 0\.8 /);
    assert.ok(args.includes('-dMonoImageFilter=/CCITTFaxEncode'));
});

test('baja: sin cambios (ni reducción ni JPEG forzado)', () => {
    const args = compressArgs(COMPRESS_LEVELS.low, 'in.pdf', 'out.pdf');
    assert.ok(args.includes('-dDownsampleColorImages=false'));
    assert.ok(args.includes('-dDownsampleMonoImages=false'));
    assert.ok(!args.includes('-c'));
    assert.ok(!args.some((a) => a.includes('DCTEncode') || a.includes('PassThroughJPEG')));
    assert.equal(args.at(-1), 'in.pdf');
});
