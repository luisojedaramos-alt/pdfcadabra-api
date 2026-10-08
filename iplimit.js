const crypto = require('crypto');

// Límite por cliente, en memoria: como mucho `maxConcurrent` peticiones a la vez (desde que
// empieza la subida hasta que se cierra la respuesta) y `maxPerWindow` en cada ventana de
// `windowMs` (ventana fija que empieza con la primera petición). La clave es un HMAC de la
// IP con una clave aleatoria de cada arranque: no se guarda ninguna IP (ni en memoria, ni
// en disco, ni en logs) y la clave no sirve tras reiniciar. Las entradas sin peticiones en
// curso y con la ventana caducada se purgan.
function createIpLimiter({ maxConcurrent, maxPerWindow, windowMs, now = Date.now }) {
    const secret = crypto.randomBytes(32);
    const entries = new Map(); // clave -> { active, count, windowStart }

    const keyFor = (ip) => crypto.createHmac('sha256', secret).update(String(ip)).digest('base64url');
    const expired = (entry, t) => t - entry.windowStart >= windowMs;

    const purge = () => {
        const t = now();
        for (const [key, entry] of entries) {
            if (entry.active === 0 && expired(entry, t)) entries.delete(key);
        }
    };
    const timer = setInterval(purge, windowMs);
    timer.unref();

    // { ok: true, release } (release idempotente) o { ok: false, reason, retryAfterS } con
    // reason 'CONCURRENT' (ya tiene maxConcurrent en curso) o 'RATE' (ventana agotada).
    const acquire = (ip) => {
        const key = keyFor(ip);
        const t = now();
        let entry = entries.get(key);
        if (!entry) {
            entry = { active: 0, count: 0, windowStart: t };
            entries.set(key, entry);
        } else if (expired(entry, t)) {
            entry.count = 0;
            entry.windowStart = t;
        }
        if (entry.active >= maxConcurrent) return { ok: false, reason: 'CONCURRENT', retryAfterS: 10 };
        if (entry.count >= maxPerWindow) {
            return { ok: false, reason: 'RATE', retryAfterS: Math.max(1, Math.ceil((entry.windowStart + windowMs - t) / 1000)) };
        }
        entry.active++;
        entry.count++;
        let released = false;
        return {
            ok: true,
            release: () => {
                if (released) return;
                released = true;
                entry.active--;
            }
        };
    };

    return { acquire, purge, size: () => entries.size, keys: () => [...entries.keys()], stop: () => clearInterval(timer) };
}

module.exports = { createIpLimiter };
