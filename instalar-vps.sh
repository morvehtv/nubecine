#!/bin/bash
# Instala NubeCine en un VPS Linux (Ubuntu/Debian).
# Uso: bash instalar-vps.sh [dominio]
#  - Si los puertos 80/443 están libres: instala con Caddy y HTTPS automático.
#  - Si ya están ocupados por otras webs: NO las toca; NubeCine va sola en un puerto libre (8090…).
set -e
cd "$(dirname "$0")"
DOMAIN_ARG="${1:-}"

echo "==> Comprobando Docker…"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

mkdir -p rclone data
busy() { ss -tln | awk '{print $4}' | grep -qE "[:.]$1\$"; }

if [ ! -f .env ]; then
  INVITE=$(tr -dc 'a-z0-9' </dev/urandom | head -c 8)
  cp .env.example .env
  sed -i "s/^INVITE_CODE=.*/INVITE_CODE=$INVITE/" .env
  if [ -n "$DOMAIN_ARG" ]; then sed -i "s/^DOMAIN=.*/DOMAIN=$DOMAIN_ARG/" .env
  else sed -i "s/^DOMAIN=.*/DOMAIN=:80/" .env; fi
fi

if busy 80 || busy 443; then
  # Ya hay otras webs en 80/443: modo convivencia
  if ! grep -q '^PUBLIC_PORT=' .env; then
    for p in $(seq 8090 8099); do busy "$p" || { PORT=$p; break; }; done
    [ -z "$PORT" ] && { echo "No hay puertos libres entre 8090 y 8099"; exit 1; }
    echo "PUBLIC_PORT=$PORT" >> .env
  fi
  PORT=$(grep '^PUBLIC_PORT=' .env | cut -d= -f2)
  echo "==> Los puertos 80/443 ya están en uso por otras webs: no se tocan."
  echo "==> NubeCine se instalará en el puerto $PORT."
  # Así cualquier "docker compose ..." posterior usa también el modo convivencia
  grep -q '^COMPOSE_FILE=' .env || echo "COMPOSE_FILE=docker-compose.yml:docker-compose.solo.yml" >> .env
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow "$PORT"/tcp >/dev/null; fi
  docker compose -f docker-compose.yml -f docker-compose.solo.yml up -d --build nubecine
  IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  URL="http://$IP:$PORT"
else
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
  grep -q '^COMPOSE_PROFILES=' .env || echo 'COMPOSE_PROFILES=https' >> .env
  docker compose up -d --build
  IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  DOMAIN_VAL=$(grep '^DOMAIN=' .env | cut -d= -f2)
  URL="http://$IP"; [ "$DOMAIN_VAL" != ":80" ] && URL="https://$DOMAIN_VAL"
fi

sleep 3
echo
echo "============================================================"
echo " NubeCine está funcionando en: $URL"
echo " Código de invitación: $(grep '^INVITE_CODE=' .env | cut -d= -f2)"
echo " El primer usuario que se registre será el administrador."
if [ ! -f rclone/rclone.conf ]; then
  echo
  echo " Falta conectar Jottacloud. Ejecuta:"
  echo "   bash $(pwd)/conectar-jottacloud.sh"
fi
echo "============================================================"
