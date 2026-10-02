#!/bin/bash
# Preparación de un servidor Ubuntu 24.04 recién creado para pdfcadabra-api.
# Se ejecuta como root, una vez (es idempotente: repetirlo no rompe nada).
#
#   bash setup.sh
#
# Qué hace:
#   1. Actualiza el sistema e instala ufw, fail2ban, unattended-upgrades y Docker (repo oficial).
#   2. Crea el usuario sin root DEPLOY_USER (por defecto "pdfcadabra") con las mismas claves
#      SSH que root, sudo sin contraseña (no tiene contraseña) y acceso a Docker.
#   3. Cortafuegos ufw: solo 22, 80 y 443 (TCP) de entrada.
#   4. fail2ban para sshd.
#   5. Actualizaciones de seguridad automáticas, con reinicio a las 04:30 si hace falta.
#   6. journald: logs persistentes con retención de 7 días (Docker manda ahí los suyos).
#   6b. Quita el swap (las subidas van a un tmpfs en RAM).
#   7. Carpeta /opt/pdfcadabra, del usuario nuevo.
#
# NO toca la configuración de SSH: eso lo hace ssh-lockdown.sh, que se lanza solo después
# de comprobar que se entra con el usuario nuevo (si no, se podría perder el acceso).
set -euo pipefail

DEPLOY_USER=${DEPLOY_USER:-pdfcadabra}
APP_DIR=/opt/pdfcadabra

[ "$(id -u)" = 0 ] || { echo "Ejecútalo como root"; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { echo "Pensado para Ubuntu 24.04 (es $PRETTY_NAME)"; exit 1; }
[ -s /root/.ssh/authorized_keys ] || { echo "root no tiene claves en authorized_keys"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
step() { echo; echo "== $*"; }

step "1. Paquetes base"
apt-get update
apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
apt-get install -y ca-certificates curl gnupg ufw fail2ban python3-systemd unattended-upgrades

step "1b. Docker (repositorio oficial)"
if ! command -v docker > /dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Logs de todos los contenedores a journald (retención de 7 días, paso 6).
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "journald"
}
EOF
systemctl enable docker
systemctl restart docker

step "2. Usuario $DEPLOY_USER"
if ! id "$DEPLOY_USER" > /dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
# Sin contraseña (solo entra con clave), así que sudo no puede pedirla.
echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$DEPLOY_USER"
chmod 440 "/etc/sudoers.d/90-$DEPLOY_USER"
visudo -cf "/etc/sudoers.d/90-$DEPLOY_USER"

step "3. Cortafuegos (ufw): 22, 80 y 443"
# Docker publica puertos saltándose ufw: por eso solo Caddy publica puertos (80 y 443), que
# ufw también permite; la API no publica ninguno.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

step "4. fail2ban (sshd)"
# En Ubuntu la unidad es ssh.service; el filtro por defecto busca sshd.service y no
# vería ningún intento.
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
backend  = systemd
journalmatch = _SYSTEMD_UNIT=ssh.service + _COMM=sshd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable fail2ban
systemctl restart fail2ban

step "5. Actualizaciones automáticas"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52pdfcadabra-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable unattended-upgrades

step "6. journald: retención de 7 días"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/pdfcadabra.conf <<'EOF'
[Journal]
Storage=persistent
MaxRetentionSec=7day
SystemMaxUse=500M
EOF
systemctl restart systemd-journald

step "6b. Sin swap"
# Las subidas van a un tmpfs en RAM: con swap, sus páginas podrían acabar escritas en disco.
# La imagen de Clouding trae /swapfile.
swapoff -a
sed -i -E '/^[^#].*[[:space:]]swap[[:space:]]/d' /etc/fstab
rm -f /swapfile
[ -z "$(swapon --show --noheadings)" ] || { echo "Sigue habiendo swap activo"; exit 1; }

step "7. Carpeta de la aplicación"
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"

echo
echo "Hecho. Antes de cerrar esta sesión de root, comprueba desde tu PC que entras con:"
echo "  ssh $DEPLOY_USER@<IP>   y que   sudo -n true && docker ps   funcionan."
echo "Después: bash ssh-lockdown.sh"
