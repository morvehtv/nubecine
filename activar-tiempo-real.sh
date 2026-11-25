#!/bin/bash
# Activa (una sola vez):
#  - Contenido en tiempo real: revisa Jottacloud cada minuto.
#  - Actualizaciones automáticas: el VPS se actualiza solo desde GitHub cada 2 minutos.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "==> Revisando Jottacloud cada minuto…"
sed -i '/^AUTO_SCAN_MINUTES=/d' .env
echo 'AUTO_SCAN_MINUTES=1' >> .env

echo "==> Programando la actualización automática cada 2 minutos…"
command -v git >/dev/null 2>&1 || apt-get install -y git >/dev/null 2>&1 || true
cat > /etc/cron.d/nubecine <<CRON
# NubeCine: actualización automática desde GitHub
*/2 * * * * root NUBECINE_DIR=$DIR bash $DIR/auto-actualizar.sh >> /var/log/nubecine-actualizar.log 2>&1
CRON
chmod 644 /etc/cron.d/nubecine

echo "==> Aplicando la versión actual…"
FORZAR=1 bash "$DIR/actualizar.sh"
git ls-remote "https://github.com/${NUBECINE_REPO:-morvehtv/nubecine}" refs/heads/main 2>/dev/null | cut -f1 > "$DIR/.version" || true

echo
echo "============================================================"
echo " Tiempo real activado."
echo "  - Lo que subas a Jottacloud aparece en 1 minuto, sin recargar."
echo "  - Las mejoras de GitHub se instalan solas en 2 minutos."
echo " Historial de actualizaciones: tail /var/log/nubecine-actualizar.log"
echo "============================================================"
