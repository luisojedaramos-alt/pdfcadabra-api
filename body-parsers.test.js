// Sin parsers globales de body: un JSON o un formulario urlencoded enviado a cualquier ruta
// no se lee ni se parsea en memoria (antes, express.json y express.urlencoded con límite de
// 100 MB lo hacían en todas las rutas, aunque ninguna los usa).
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./server');

// Ruta de prueba añadida tras cargar server.js: dice si el body llegó parseado y si el
// cuerpo ya se había leído entero al llegar al handler.
app.post('/__sonda-body', (req, res) => {
    res.json({ parsed: req.body !== undefined, complete: req.complete });
});

const listen = async (t) => {
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));
    return `http://127.0.0.1:${server.address().port}`;
};

const MB = 1024 * 1024;
const bigJson = () => JSON.stringify({ x: 'a'.repeat(MB) });

for (const [type, body] of [
    ['application/json', bigJson()],
    ['application/x-www-form-urlencoded', `x=${'a'.repeat(MB)}`]
]) {
    test(`${type}: el body no se parsea ni se lee antes de llegar a la ruta`, async (t) => {
        const base = await listen(t);
        const res = await fetch(`${base}/__sonda-body`, { method: 'POST', headers: { 'Content-Type': type }, body });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { parsed: false, complete: false });
    });
}
