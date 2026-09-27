const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./server');

test('GET /health responde 200 con {"status":"ok"} y sin caché', async (t) => {
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((r) => server.once('listening', r));

    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { status: 'ok' });
});
