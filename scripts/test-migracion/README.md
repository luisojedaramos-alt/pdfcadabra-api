# test-migracion

Prueba de la rama `chore/node-trixie` (imagen `node:24-trixie-slim`) en un servicio
temporal de Render, comparada con producción (`node:20-bookworm-slim`). Solo curl:
el CORS únicamente acepta pdfcadabra.com, pero las peticiones sin `Origin` pasan.

## 1. Servicio temporal en Render

1. Render → **New → Web Service** → repositorio `luisojedaramos-alt/pdfcadabra-api`.
2. **Name**: `pdfcadabra-api-trixie` · **Branch**: `chore/node-trixie` ·
   **Language**: Docker · **Region**: Frankfurt (EU Central) · **Instance type**: Free.
   Root Directory y Dockerfile Path, por defecto (`./Dockerfile`).
3. **Environment variables**: `NODE_ENV=production` y las mismas que tenga
   producción (p. ej. `HEAVY_*`, si hay alguna). `PORT` la pone Render.
4. **Advanced → Docker Command** (muestra versiones al arrancar y, cada 20 s, cuántos
   archivos hay en la carpeta de temporales):

   ```
   sh -c 'node -v; gs --version; python3 --version; pip show PyMuPDF | head -2; node server.js & while sleep 20; do echo "[tmpcheck] $(ls -A /tmp/pdfcadabra-uploads 2>/dev/null | wc -l) archivos en /tmp/pdfcadabra-uploads"; done'
   ```

5. **Create Web Service** y esperar a *Live*. En **Logs** deben salir `v24.x`,
   `10.05.1`, `Python 3.13.x` y `Version: 1.28.2`.

## 2. Prueba

```sh
bash scripts/test-migracion/run.sh https://pdfcadabra-api-trixie.onrender.com
```

Opcionales: 2.º argumento, URL de producción; 3.º, repeticiones por medida (3).
Necesita Python 3 (instala Pillow en un venv temporal si falta). Genera los PDF
sintéticos con `gen_pdfs.py`, sin datos reales, y deja el informe en una carpeta
temporal (la ruta sale al final). Envía unas 22 peticiones pequeñas a producción y 25 al temporal.

Marca con `<--` los tamaños de Comprimir que difieran más de un 5 %, los estados
distintos y los tiempos más de un 20 % peores. Los tiempos solo son comparables si
producción usa el mismo tipo de instancia que el temporal (Free).

Al terminar, esperar ~60 s y comprobar en Logs del temporal que el último
`[tmpcheck]` dice `0 archivos`.

## 3. Después

Borrar el servicio temporal (Settings → Delete Web Service). No fusionar la rama
en `main` sin revisar el informe.
