# deploy

pdfcadabra-api en un VPS propio (Clouding, Ubuntu 24.04, 4 vCPU, 8 GB) en vez de Render.
La imagen se construye con el mismo `Dockerfile` del repo; Caddy pone el HTTPS de
`api.pdfcadabra.com` (Let's Encrypt) y es lo único que publica puertos.

| Archivo | Qué es |
|---|---|
| `setup.sh` | Prepara el servidor como root: paquetes, Docker, usuario `pdfcadabra`, ufw (22/80/443), fail2ban, actualizaciones automáticas, journald con 7 días |
| `ssh-lockdown.sh` | SSH solo con clave, sin root ni contraseña. Solo tras comprobar que entra el usuario nuevo |
| `docker-compose.yml` | API (cola HEAVY: 3 a la vez y 8 en espera, `/tmp` en tmpfs, reinicio automático) + Caddy |
| `Caddyfile` | HTTPS para `api.pdfcadabra.com`, sin log de accesos |
| `bench.sh` | Medición de `/v1/compress` con curl (6 en serie o N simultáneas) |

## Privacidad

- Subidas, intermedios y temporales de Ghostscript van a `/tmp` del contenedor, que es un
  tmpfs (RAM): no llegan al disco. No hay swap en el servidor (comprobar con `swapon --show`):
  si se añade, el tmpfs podría acabar en disco.
- Caddy no tiene log de accesos. La API solo registra códigos de error y los primeros
  200 caracteres de stderr sin rutas (`errlog.js`), nunca nombres ni contenido.
- Logs de contenedores y del sistema en journald, borrados a los 7 días
  (`journalctl -u docker` o `journalctl CONTAINER_TAG=pdfcadabra-api`).

## Primera instalación

Desde el PC, como root (solo hasta `ssh-lockdown.sh`; después root ya no entra). Antes,
esperar a que acabe la instalación inicial de la imagen: `cloud-init status --wait`.

```sh
KEY=~/.ssh/pdfcadabra_clouding_rsa
scp -i $KEY -r deploy root@<IP>:/root/deploy
ssh -i $KEY root@<IP> 'bash /root/deploy/setup.sh'
# Entrar con el usuario nuevo ANTES de bloquear root
ssh -i $KEY pdfcadabra@<IP> 'sudo -n true && docker ps'
ssh -i $KEY root@<IP> 'bash /root/deploy/ssh-lockdown.sh && rm -rf /root/deploy'
```

Después, la entrada `pdfcadabra-clouding` de `~/.ssh/config` (HostName, `User pdfcadabra`,
IdentityFile, `IdentitiesOnly yes`) es la que usan los comandos de abajo.

## Desplegar una versión

El servidor no tiene credenciales de GitHub: el código se envía desde el PC con
`git archive` (solo lo versionado, sin `node_modules`):

```sh
REV=$(git rev-parse main)
git archive --format=tar main | ssh pdfcadabra-clouding \
  'rm -rf /opt/pdfcadabra/api.new && mkdir /opt/pdfcadabra/api.new && tar -x -C /opt/pdfcadabra/api.new'
ssh pdfcadabra-clouding "cd /opt/pdfcadabra && rm -rf api.old && { [ ! -d api ] || mv api api.old; } && mv api.new api \
  && echo $REV > api/REVISION && docker compose -f api/deploy/docker-compose.yml up -d --build"
```

Si la versión cambia el `Caddyfile`, hay que reiniciar Caddy tras la rotación. El archivo
está montado desde `api/deploy/Caddyfile` y, después del `mv api api.old`, el contenedor
sigue leyendo el antiguo (ahora en `api.old`). Por eso `caddy reload` dentro del contenedor
no basta, y `up -d` no recrea Caddy porque su configuración de compose no cambia:

```sh
# Antes de desplegar, anotar el certificado que se sirve:
echo | openssl s_client -connect api.pdfcadabra.com:443 -servername api.pdfcadabra.com 2>/dev/null \
  | openssl x509 -noout -serial -enddate
# Tras la rotación:
ssh pdfcadabra-clouding 'docker run --rm -v /opt/pdfcadabra/api/deploy/Caddyfile:/etc/caddy/Caddyfile:ro \
  caddy:2 caddy validate --config /etc/caddy/Caddyfile \
  && docker compose -f /opt/pdfcadabra/api/deploy/docker-compose.yml restart caddy \
  && docker exec pdfcadabra-caddy-1 cat /etc/caddy/Caddyfile'
# Después, repetir el openssl de arriba: mismo serial (el certificado está en el volumen
# caddy_data; reiniciar no pide uno nuevo).
```

Lección (2026-10-08): si se pasa un script al servidor por stdin (`ssh ... 'bash -s' < script`),
`docker compose exec` (también con `-T`) y `docker exec -i` leen ese stdin y se comen el resto
del script, que deja de ejecutarse sin dar error. Dentro de esos scripts, poner `< /dev/null`
a cada `docker compose exec` / `docker exec -i`, o mandar el script de otra forma (p. ej.
base64 en el argumento de ssh).

Comprobar versiones dentro del contenedor (deben coincidir con Render: Node 24, gs 10.05.1,
Python 3.13, PyMuPDF 1.28.2):

```sh
docker compose -f /opt/pdfcadabra/api/deploy/docker-compose.yml exec api \
  sh -c 'node -v; gs --version; python3 --version; pip show PyMuPDF | head -2'
```

## DNS (Cloudflare)

`A  api  <IP del servidor>`, proxy desactivado (nube gris, "DNS only"), TTL Auto. Con la
nube naranja Cloudflare cortaría las peticiones a los 100 s y limitaría la subida a 100 MB.
