const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweepOldFiles } = require('./cleanup');

const MIN = 60 * 1000;

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
const touch = (dir, name, ageMs, now) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    const t = new Date(now - ageMs);
    fs.utimesSync(file, t, t);
    return file;
};

test('borra solo los archivos con más de la antigüedad máxima', async () => {
    const dir = makeDir();
    const now = Date.now();
    const old = touch(dir, 'old.pdf', 16 * MIN, now);
    const fresh = touch(dir, 'fresh.pdf', 5 * MIN, now);

    const removed = await sweepOldFiles(dir, 15 * MIN, now);

    assert.equal(removed, 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    fs.rmSync(dir, { recursive: true });
});

test('borra las subcarpetas antiguas con su contenido y deja las recientes', async () => {
    const dir = makeDir();
    const now = Date.now();
    const age = (p, ms) => { const t = new Date(now - ms); fs.utimesSync(p, t, t); };
    const old = path.join(dir, 'gs-old');
    const fresh = path.join(dir, 'gs-fresh');
    for (const sub of [old, fresh]) {
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'gs_abc123'), 'x'); // temporal de Ghostscript
    }
    age(old, 60 * MIN);
    age(fresh, 5 * MIN);

    assert.equal(await sweepOldFiles(dir, 15 * MIN, now), 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(path.join(fresh, 'gs_abc123')), true);
    fs.rmSync(dir, { recursive: true });
});

test('una carpeta inexistente no es un error', async () => {
    assert.equal(await sweepOldFiles(path.join(os.tmpdir(), 'no-existe-' + Date.now()), 15 * MIN), 0);
});
