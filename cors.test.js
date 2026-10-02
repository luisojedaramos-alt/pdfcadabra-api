// CORS: NODE_ENV=production + EXTRA_ALLOWED_ORIGINS (el branch deploy de dev para la QA).
// node --test ejecuta cada archivo en su propio proceso: las variables se fijan antes de
// cargar server.js, que calcula ALLOWED_ORIGINS al importarse.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'production';
process.env.EXTRA_ALLOWED_ORIGINS = ' https://dev--pdfcadabra.netlify.app , http://inseguro.example.com,https://*.netlify.app,https://con-barra.example.com/,';
const app = require('./server');
const { buildAllowedOrigins } = app;

const allowOrigin = async (origin) => {
    const server = app.listen(0);
    try {
        await new Promise((r) => server.once('listening', r));
        const res = await fetch(`http://127.0.0.1:${server.address().port}/health`, { headers: { Origin: origin } });
        assert.equal(res.status, 200);
        return res.headers.get('access-control-allow-origin');
    } finally {
        server.close();
    }
};

test('producción con EXTRA_ALLOWED_ORIGINS: pasa el dominio de dev, no localhost ni los inválidos', async () => {
    assert.equal(await allowOrigin('https://pdfcadabra.com'), 'https://pdfcadabra.com');
    assert.equal(await allowOrigin('https://www.pdfcadabra.com'), 'https://www.pdfcadabra.com');
    assert.equal(await allowOrigin('https://dev--pdfcadabra.netlify.app'), 'https://dev--pdfcadabra.netlify.app');
    for (const origin of [
        'http://localhost:5173',
        'http://localhost:3000',
        'http://inseguro.example.com',
        'https://deploy-preview-1--pdfcadabra.netlify.app',
        'https://con-barra.example.com'
    ]) {
        assert.equal(await allowOrigin(origin), null, origin);
    }
});

test('buildAllowedOrigins: base según NODE_ENV y extras válidos sin duplicados', () => {
    const quiet = test.mock.method(console, 'warn', () => {});
    try {
        assert.deepEqual(buildAllowedOrigins({ NODE_ENV: 'production' }), ['https://pdfcadabra.com', 'https://www.pdfcadabra.com']);
        assert.deepEqual(buildAllowedOrigins({}), [
            'https://pdfcadabra.com', 'https://www.pdfcadabra.com', 'http://localhost:3000', 'http://localhost:5173'
        ]);
        assert.deepEqual(
            buildAllowedOrigins({ NODE_ENV: 'production', EXTRA_ALLOWED_ORIGINS: 'https://pdfcadabra.com,https://a.example.com,https://a.example.com' }),
            ['https://pdfcadabra.com', 'https://www.pdfcadabra.com', 'https://a.example.com']
        );
        assert.deepEqual(buildAllowedOrigins({ NODE_ENV: 'production', EXTRA_ALLOWED_ORIGINS: 'https://*.netlify.app, ftp://x.com, https://x.com/ruta' }), [
            'https://pdfcadabra.com', 'https://www.pdfcadabra.com'
        ]);
        assert.equal(quiet.mock.callCount(), 3);
    } finally {
        quiet.mock.restore();
    }
});
