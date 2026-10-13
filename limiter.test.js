const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, QueueError } = require('./limiter');

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const make = (opts = {}) => createLimiter({ maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 1000, ...opts });

test('respeta maxConcurrent y atiende en orden FIFO', async () => {
    const limiter = make({ maxConcurrent: 2, maxQueue: 5 });
    const started = [];
    const releases = {};
    const run = (id) => limiter.acquire(id).then((release) => {
        started.push(id);
        releases[id] = release;
    });

    ['a', 'b', 'c', 'd'].forEach(run);
    await tick();
    assert.deepEqual(started, ['a', 'b']);

    releases.a();
    await tick();
    assert.deepEqual(started, ['a', 'b', 'c']);

    releases.b();
    await tick();
    assert.deepEqual(started, ['a', 'b', 'c', 'd']);
    releases.c();
    releases.d();
});

test('getStatus informa de posición en cola y de ejecución', async () => {
    const limiter = make({ maxQueue: 3 });
    const r1 = await limiter.acquire('a');
    limiter.acquire('b').catch(() => {});
    limiter.acquire('c').catch(() => {});
    await tick();

    assert.deepEqual(limiter.getStatus('a'), { state: 'running' });
    assert.deepEqual(limiter.getStatus('b'), { state: 'queued', position: 1 });
    assert.deepEqual(limiter.getStatus('c'), { state: 'queued', position: 2 });
    assert.deepEqual(limiter.getStatus('zzz'), { state: 'unknown' });

    r1();
    await tick();
    assert.deepEqual(limiter.getStatus('b'), { state: 'running' });
    assert.deepEqual(limiter.getStatus('c'), { state: 'queued', position: 1 });
    assert.deepEqual(limiter.getStatus('a'), { state: 'unknown' });
});

test('rechaza con QUEUE_FULL cuando la cola está llena, sin afectar a los demás', async () => {
    const limiter = make({ maxQueue: 1 });
    const r1 = await limiter.acquire('a');
    const pB = limiter.acquire('b');
    await assert.rejects(limiter.acquire('c'), (e) => e instanceof QueueError && e.code === 'QUEUE_FULL');

    r1();
    const rB = await pB;
    rB();
});

test('maxQueue=0 admite peticiones si hay hueco y rechaza si no', async () => {
    const limiter = make({ maxQueue: 0 });
    const r1 = await limiter.acquire('a');
    await assert.rejects(limiter.acquire('b'), { code: 'QUEUE_FULL' });
    r1();
    const r2 = await limiter.acquire('c');
    r2();
});

test('QUEUE_TIMEOUT: rechaza al agotar la espera y no bloquea el hueco después', async () => {
    const limiter = make({ queueTimeoutMs: 30 });
    const r1 = await limiter.acquire('a');
    await assert.rejects(limiter.acquire('b'), { code: 'QUEUE_TIMEOUT' });
    assert.deepEqual(limiter.getStatus('b'), { state: 'unknown' });

    // 'b' ya salió de la cola: al liberar 'a' no debe quedarse con el hueco y 'c'
    // debe poder entrar.
    r1();
    const r3 = await limiter.acquire('c');
    assert.deepEqual(limiter.getStatus('c'), { state: 'running' });
    r3();
});

test('cancel saca de la cola a una petición en espera; no afecta a la que ejecuta', async () => {
    const limiter = make();
    const r1 = await limiter.acquire('a');
    const pB = limiter.acquire('b');
    const pC = limiter.acquire('c');

    assert.equal(limiter.cancel('b'), true);
    await assert.rejects(pB, { code: 'CANCELLED' });
    assert.deepEqual(limiter.getStatus('c'), { state: 'queued', position: 1 });
    assert.equal(limiter.cancel('a'), false); // ya ejecutando
    assert.equal(limiter.cancel('nope'), false);

    r1();
    const rC = await pC;
    rC();
});

test('release es idempotente y no libera dos veces el hueco', async () => {
    const limiter = make({ maxConcurrent: 1, maxQueue: 5 });
    const r1 = await limiter.acquire('a');
    let bStarted = false;
    let cStarted = false;
    const pB = limiter.acquire('b').then((r) => { bStarted = true; return r; });
    const pC = limiter.acquire('c').then((r) => { cStarted = true; return r; });

    r1();
    r1(); // segunda llamada: no debe dejar pasar a 'c'
    await tick();
    assert.equal(bStarted, true);
    assert.equal(cStarted, false);

    (await pB)();
    (await pC)();
});

test('id duplicado se rechaza sin tocar el ticket original', async () => {
    const limiter = make();
    const r1 = await limiter.acquire('a');
    await assert.rejects(limiter.acquire('a'), { code: 'DUPLICATE_ID' });
    assert.deepEqual(limiter.getStatus('a'), { state: 'running' });
    r1();
});

test('un timeout ya cumplido no dispara sobre peticiones que ya empezaron', async () => {
    const limiter = make({ queueTimeoutMs: 40 });
    const r1 = await limiter.acquire('a');
    const pB = limiter.acquire('b');
    r1();
    const rB = await pB;
    await sleep(80); // pasa el timeout de 'b': no debe cancelarlo
    assert.deepEqual(limiter.getStatus('b'), { state: 'running' });
    rB();
});

test('peso 2: ocupa dos huecos; con 3, cabe uno de peso 1 más y el siguiente espera', async () => {
    const limiter = make({ maxConcurrent: 3, maxQueue: 5 });
    const rBig = await limiter.acquire('big', 2);
    assert.equal(limiter.slotsInUse(), 2);
    const rA = await limiter.acquire('a');
    const pB = limiter.acquire('b');
    await tick();
    assert.deepEqual(limiter.getStatus('b'), { state: 'queued', position: 1 });

    rBig();
    const rB = await pB;
    assert.equal(limiter.slotsInUse(), 2);
    rA();
    rB();
    assert.equal(limiter.slotsInUse(), 0);
});

test('peso 2 en cola: FIFO estricto, los de detrás no se le adelantan', async () => {
    const limiter = make({ maxConcurrent: 3, maxQueue: 5 });
    const r1 = await limiter.acquire('a');
    const r2 = await limiter.acquire('b');
    const started = [];
    const pBig = limiter.acquire('big', 2).then((r) => { started.push('big'); return r; });
    const pC = limiter.acquire('c').then((r) => { started.push('c'); return r; });
    await tick();
    // Queda un hueco libre, pero 'big' necesita dos y va primero: 'c' espera.
    assert.deepEqual(started, []);
    assert.deepEqual(limiter.getStatus('c'), { state: 'queued', position: 2 });

    r1();
    await tick();
    assert.deepEqual(started, ['big']);
    r2();
    await tick();
    assert.deepEqual(started, ['big', 'c']);
    (await pBig)();
    (await pC)();
});

test('peso 2 en cola: si se cancela o caduca, entran los de detrás que quepan', async () => {
    const limiter = make({ maxConcurrent: 3, maxQueue: 5, queueTimeoutMs: 30 });
    const r1 = await limiter.acquire('a');
    const r2 = await limiter.acquire('b');
    const pBig = limiter.acquire('big', 2);
    const pC = limiter.acquire('c');
    await assert.rejects(pBig, { code: 'QUEUE_TIMEOUT' });
    const rC = await pC;
    assert.deepEqual(limiter.getStatus('c'), { state: 'running' });
    r1();
    r2();
    rC();
});

test('un peso mayor que maxConcurrent ocupa todos los huecos, no espera para siempre', async () => {
    const limiter = make({ maxConcurrent: 1, maxQueue: 2 });
    const rBig = await limiter.acquire('big', 2);
    assert.equal(limiter.slotsInUse(), 1);
    rBig();
});

test('QUEUE_FULL con peso: si no cabe ahora y la cola está llena', async () => {
    const limiter = make({ maxConcurrent: 3, maxQueue: 0 });
    const r1 = await limiter.acquire('a', 2);
    await assert.rejects(limiter.acquire('big', 2), { code: 'QUEUE_FULL' });
    const r2 = await limiter.acquire('b');
    r1();
    r2();
});
