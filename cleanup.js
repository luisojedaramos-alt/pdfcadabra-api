const fs = require('fs');
const path = require('path');

// Borra de `dir` los archivos cuya última modificación tiene más de `maxAgeMs`.
// Red de seguridad para lo que el borrado por petición no alcanza (proceso
// reiniciado o matado a mitad de una petición). Devuelve cuántos borró.
const sweepOldFiles = async (dir, maxAgeMs, now = Date.now()) => {
    let entries;
    try {
        entries = await fs.promises.readdir(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return 0;
        throw err;
    }

    let removed = 0;
    for (const name of entries) {
        const file = path.join(dir, name);
        try {
            const stat = await fs.promises.stat(file);
            if (!stat.isFile() || now - stat.mtimeMs <= maxAgeMs) continue;
            await fs.promises.unlink(file);
            removed++;
        } catch (err) {
            // ENOENT: lo borró entretanto la propia petición.
            if (err.code !== 'ENOENT') console.error(`Error en la limpieza periódica (${file}):`, err);
        }
    }
    return removed;
};

// Barrido al arrancar y después cada `intervalMs`. unref(): el temporizador no
// mantiene vivo el proceso por sí solo.
const startPeriodicSweep = (dir, maxAgeMs, intervalMs) => {
    const run = () => sweepOldFiles(dir, maxAgeMs)
        .then((removed) => {
            if (removed > 0) console.warn(`[Limpieza] ${removed} archivo(s) temporales con más de ${maxAgeMs / 60000} min borrados.`);
        })
        .catch((err) => console.error('Error en la limpieza periódica:', err));
    run();
    return setInterval(run, intervalMs).unref();
};

module.exports = { sweepOldFiles, startPeriodicSweep };
