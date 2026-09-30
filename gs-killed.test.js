// Con el Ghostscript real: un gs matado a mitad (como hace el tope de tiempo de
// /v1/compress, con SIGKILL) deja sus archivos de trabajo en la carpeta de TMPDIR/TEMP/TMP
// que le pasa server.js, y ninguno en el temporal del sistema; el barrido los elimina.
// Se omite si no hay Ghostscript instalado (GS_BIN elige el ejecutable).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { sweepOldFiles } = require('./cleanup');

function findGs() {
    const candidates = [process.env.GS_BIN, 'gs', 'gswin64c'].filter(Boolean);
    if (process.platform === 'win32') {
        const base = 'C:/Program Files/gs';
        if (fs.existsSync(base)) {
            for (const v of fs.readdirSync(base).sort().reverse()) {
                candidates.push(path.join(base, v, 'bin', 'gswin64c.exe'));
            }
        }
    }
    for (const c of candidates) {
        try {
            execFileSync(c, ['--version'], { stdio: 'ignore' });
            return c;
        } catch {
            /* siguiente */
        }
    }
    return null;
}

const GS = findGs();

// Archivos de trabajo de gs: gs_XXXXXX en Linux, _teXXXX.tmp en Windows.
const scratch = (dir) => fs.readdirSync(dir).filter((f) => /^gs_|^_te.*\.tmp$/i.test(f));

test('un gs abortado no deja temporales fuera de su carpeta', { skip: !GS && 'Ghostscript no instalado' }, async () => {
    // Un "sistema" y un pdfcadabra-uploads propios del test: así se ve si gs escribe fuera.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-killed-test-'));
    const systemTmp = path.join(root, 'sistema');
    const uploads = path.join(systemTmp, 'pdfcadabra-uploads');
    const gsTmpDir = path.join(uploads, 'gs-prueba');
    fs.mkdirSync(gsTmpDir, { recursive: true });

    // Entorno como el de server.js, sobre un entorno cuyo temporal es `systemTmp`.
    const base = { ...process.env, TMPDIR: systemTmp, TEMP: systemTmp, TMP: systemTmp };
    const env = { ...base, TMPDIR: gsTmpDir, TEMP: gsTmpDir, TMP: gsTmpDir };
    const args = [
        '-sDEVICE=pdfwrite', '-dNOPAUSE', '-dQUIET', '-dBATCH',
        `-sOutputFile=${path.join(uploads, 'salida.pdf')}`,
        // Una página y luego un bucle infinito: gs sigue vivo hasta que lo matan.
        '-c', '/Helvetica findfont 12 scalefont setfont 72 72 moveto (hola) show showpage { } loop'
    ];
    const error = await new Promise((resolve) => {
        execFile(GS, args, { timeout: 1500, killSignal: 'SIGKILL', env }, (err) => resolve(err));
    });

    try {
        assert.ok(error && error.killed && error.signal === 'SIGKILL', 'gs debe morir por el timeout');
        assert.ok(scratch(gsTmpDir).length > 0, 'gs abortado deja sus temporales... en su carpeta');
        assert.deepEqual(scratch(systemTmp), [], 'ninguno en el temporal del sistema');

        // El barrido (con antigüedad 0) elimina la carpeta entera.
        await sweepOldFiles(uploads, -1);
        assert.equal(fs.existsSync(gsTmpDir), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
