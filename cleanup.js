const fs = require('fs');
const path = require('path');
const { describeError } = require('./errlog');

// Borra de `dir` los archivos y subcarpetas (con todo su contenido, p. ej. la carpeta
// temporal de Ghostscript de una petición) cuya última modificación tiene más de
// `maxAgeMs`. Red de seguridad para lo que el borrado por petición no alcanza (proceso
// reiniciado o matado a mitad de una petición). Devuelve cuántas entradas borró.
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
            if (now - stat.mtimeMs <= maxAgeMs) continue;
            if (stat.isFile()) await fs.promises.unlink(file);
            else if (stat.isDirectory()) await fs.promises.rm(file, { recursive: true, force: true });
            else continue;
            removed++;
        } catch (err) {
            // ENOENT: lo borró entretanto la propia petición.
            if (err.code !== 'ENOENT') console.error(`Error en la limpieza periódica (${file}):`, describeError(err));
        }
    }
    return removed;
};

// Barrido al arrancar y después cada `intervalMs`. unref(): el temporizador no
// mantiene vivo el proceso por sí solo.
const startPeriodicSweep = (dir, maxAgeMs, intervalMs) => {
    const run = () => sweepOldFiles(dir, maxAgeMs)
        .then((removed) => {
            if (removed > 0) console.warn(`[Limpieza] ${removed} temporal(es) (archivos o carpetas) con más de ${maxAgeMs / 60000} min borrados.`);
        })
        .catch((err) => console.error('Error en la limpieza periódica:', describeError(err)));
    run();
    return setInterval(run, intervalMs).unref();
};

module.exports = { sweepOldFiles, startPeriodicSweep };
