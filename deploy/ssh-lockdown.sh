#!/bin/bash
# SSH solo con clave, sin login de root ni contraseñas. Se lanza DESPUÉS de setup.sh y de
# comprobar que se entra con el usuario nuevo. Las sesiones abiertas no se cortan (reload).
#
#   sudo bash ssh-lockdown.sh
set -euo pipefail

DEPLOY_USER=${DEPLOY_USER:-pdfcadabra}

[ "$(id -u)" = 0 ] || { echo "Ejecútalo como root (sudo)"; exit 1; }
[ -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ] || { echo "$DEPLOY_USER no tiene claves: no se bloquea nada"; exit 1; }

# sshd usa el primer valor que encuentra: el 00- va antes que el 50-cloud-init.conf de la
# imagen (que en algunas trae PasswordAuthentication yes).
cat > /etc/ssh/sshd_config.d/00-pdfcadabra.conf <<EOF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers $DEPLOY_USER
X11Forwarding no
EOF

sshd -t
systemctl reload ssh
echo "Configuración efectiva:"
sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|authenticationmethods|allowusers) '
