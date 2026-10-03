// PDF con contraseña de apertura (caso a) y con solo contraseña de propietario (caso b) en las
// tres rutas, con redact.py, lossless_images.py, jpeg_flate.py, pdf_check.py y Ghostscript de
// verdad (muestras sintéticas generadas con PyMuPDF). Además, la red de seguridad de Comprimir:
// un resultado con menos páginas que la entrada nunca se entrega.
//
// Necesita python3 con PyMuPDF y Ghostscript; si faltan, se salta con un aviso. En Windows:
// PYTHON=python y GS=<ruta a gswin64c.exe> (o gswin64c en el PATH).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const findGs = () => {
    if (process.env.GS) return process.env.GS;
    for (const c of ['gs', 'gswin64c']) {
        try {
            childProcess.execFileSync(c, ['--version'], { stdio: 'ignore' });
            return c;
        } catch { /* siguiente */ }
    }
    return null;
};
const GS = findGs();
let pymupdf = false;
try {
    childProcess.execFileSync(PYTHON, ['-c', 'import pymupdf'], { stdio: 'ignore' });
    pymupdf = true;
} catch { /* sin PyMuPDF */ }
const skip = !GS || !pymupdf ? 'hace falta python3 con PyMuPDF y Ghostscript' : false;

// Muestras: plain/a/b de 3 páginas con texto y una imagen de ruido (para que gs reduzca algo), y
// una de 1 página sin imagen (pesa mucho menos: pasa el umbral de ahorro) para simular un gs
// que pierde páginas.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfcadabra-cifrado-'));
const SAMPLES = `
import sys, os, pymupdf
d = sys.argv[1]
def make(name, pages=3, image=True, **enc):
    doc = pymupdf.open()
    noise = pymupdf.Pixmap(pymupdf.csRGB, 1200, 900, os.urandom(1200 * 900 * 3), False)
    for i in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 80), f"manzana1 juicio ordinario 123/2026 página {i + 1}", fontsize=14)
        if image:
            page.insert_image(pymupdf.Rect(60, 120, 535, 500), pixmap=noise)
    if enc:
        enc = dict(encryption=pymupdf.PDF_ENCRYPT_AES_256, permissions=int(pymupdf.PDF_PERM_PRINT), **enc)
    doc.save(os.path.join(d, name), **enc)
make("plain.pdf")
make("a.pdf", user_pw="qa1234", owner_pw="qa1234-owner")
make("b.pdf", user_pw="", owner_pw="qa1234-owner")
make("una.pdf", pages=1, image=False)
`;
if (!skip) childProcess.execFileSync(PYTHON, ['-c', SAMPLES, DIR]);
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// server.js llama a 'python3' y 'gs'; aquí se traducen a los de esta máquina. `gsOverride`
// permite simular un gs que escribe otra salida.
let gsOverride = null;
const realExecFile = childProcess.execFile;
childProcess.execFile = (command, args, options, callback) => {
    if (command === 'gs' && gsOverride) {
        const out = args.find((a) => a.startsWith('-sOutputFile=')).slice('-sOutputFile='.length);
        fs.copyFileSync(gsOverride, out);
        setImmediate(() => callback(null, '', ''));
        return {};
    }
    const real = command === 'python3' ? PYTHON : command === 'gs' ? GS : command;
    return realExecFile(real, args, { ...options, cwd: __dirname }, callback);
};
const app = require('./server');

async function post(t, route, sample, fields) {
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const form = new FormData();
    const bytes = fs.readFileSync(path.join(DIR, sample));
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), sample);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST', body: form });
    return { res, body: Buffer.from(await res.arrayBuffer()), input: bytes };
}

const pageCount = (buf) => {
    const file = path.join(DIR, `salida-${Date.now()}-${Math.random()}.pdf`);
    fs.writeFileSync(file, buf);
    return Number(childProcess.execFileSync(PYTHON, ['-c', 'import sys, pymupdf; print(pymupdf.open(sys.argv[1]).page_count)', file]).toString());
};

const PATTERNS = JSON.stringify({ custom_0: 'manzana1' });
const ITEMS = JSON.stringify([{ id: 'x', page: 0, rect: [55, 60, 200, 90], text: 'manzana1' }]);
const ROUTES = [
    ['/v1/compress', { level: 'recommended' }],
    ['/v1/redact/search', { patterns: PATTERNS }],
    ['/v1/redact/apply', { items: ITEMS }],
];

for (const [route, fields] of ROUTES) {
    test(`caso a) contraseña de apertura: ${route} responde 422 PDF_ENCRYPTED`, { skip }, async (t) => {
        const { res, body } = await post(t, route, 'a.pdf', fields);
        assert.equal(res.status, 422);
        const json = JSON.parse(body.toString());
        assert.equal(json.code, 'PDF_ENCRYPTED');
        assert.match(json.error, /Desbloquear PDF/);
    });
}

test('caso b) solo propietario: /v1/compress comprime y conserva todas las páginas', { skip }, async (t) => {
    const { res, body, input } = await post(t, '/v1/compress', 'b.pdf', { level: 'extreme' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-compress-status'), 'compressed');
    assert.ok(body.length < input.length);
    assert.equal(pageCount(body), 3);
});

test('caso b) solo propietario: /v1/redact/search encuentra el término', { skip }, async (t) => {
    const { res, body } = await post(t, '/v1/redact/search', 'b.pdf', { patterns: PATTERNS });
    assert.equal(res.status, 200);
    assert.ok(JSON.parse(body.toString()).results.length >= 3);
});

test('caso b) solo propietario: /v1/redact/apply censura y entrega', { skip }, async (t) => {
    const { res, body } = await post(t, '/v1/redact/apply', 'b.pdf', { items: ITEMS });
    assert.equal(res.status, 200);
    assert.equal(pageCount(body), 3);
});

test('Comprimir nunca entrega menos páginas: si gs pierde páginas, devuelve el original', { skip }, async (t) => {
    gsOverride = path.join(DIR, 'una.pdf');
    t.after(() => { gsOverride = null; });
    for (const level of ['extreme', 'recommended', 'low']) {
        const { res, body, input } = await post(t, '/v1/compress', 'plain.pdf', { level });
        assert.equal(res.status, 200, level);
        assert.equal(res.headers.get('x-compress-status'), 'already-optimized', level);
        assert.ok(body.equals(input), `${level}: debe ser el original sin tocar`);
    }
});
