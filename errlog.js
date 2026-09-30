// Resumen de un error para el log: su código y su mensaje, nunca el objeto entero. El
// objeto puede llevar el cuerpo de la petición (los errores de express.json guardan el
// texto recibido en `body`), cabeceras, rutas o datos del documento.

// Errores de body-parser cuyo mensaje (el de JSON.parse) cita el propio cuerpo recibido.
const BODY_QUOTING_TYPES = new Set(['entity.parse.failed', 'entity.verify.failed']);

const describeError = (err) => {
    if (err === null || typeof err !== 'object') return String(err);
    const code = err.code || err.type || err.name || 'Error';
    const message = BODY_QUOTING_TYPES.has(err.type)
        ? '(mensaje omitido: cita el cuerpo de la petición)'
        : String(err.message || '');
    return message ? `[${code}] ${message}` : `[${code}]`;
};

const STDERR_MAX_CHARS = 200;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Fallo de un proceso hijo (gs, redact.py, jpeg_flate.py) para el log: código de salida
// (o señal, si lo mataron) y solo los primeros 200 caracteres de stderr, con las rutas de
// la carpeta de subidas cambiadas por "<tmp>". Se sustituye antes de recortar, para que
// un corte a mitad de ruta no deje un trozo.
const describeProcessError = (error, stderr, uploadDirs) => {
    const code = error && (error.code ?? error.signal);
    let text = String(stderr || '');
    for (const dir of uploadDirs) {
        text = text.replace(new RegExp(`${escapeRegExp(dir)}[^\\s'"]*`, 'g'), '<tmp>');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > STDERR_MAX_CHARS) text = `${text.slice(0, STDERR_MAX_CHARS)}…`;
    return `código ${code ?? 'desconocido'}${text ? `: ${text}` : ''}`;
};

module.exports = { describeError, describeProcessError };
