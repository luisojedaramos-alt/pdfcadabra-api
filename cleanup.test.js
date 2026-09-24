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

test('no toca subcarpetas', async () => {
    const dir = makeDir();
    const now = Date.now();
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    const t = new Date(now - 60 * MIN);
    fs.utimesSync(sub, t, t);

    assert.equal(await sweepOldFiles(dir, 15 * MIN, now), 0);
    assert.equal(fs.existsSync(sub), true);
    fs.rmSync(dir, { recursive: true });
});

test('una carpeta inexistente no es un error', async () => {
    assert.equal(await sweepOldFiles(path.join(os.tmpdir(), 'no-existe-' + Date.now()), 15 * MIN), 0);
});
