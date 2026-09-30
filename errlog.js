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

module.exports = { describeError };
