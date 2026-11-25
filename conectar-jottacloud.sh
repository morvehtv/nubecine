#!/bin/bash
# Conecta NubeCine con tu cuenta de Jottacloud.
# Antes: entra en https://www.jottacloud.com/web/secure → "Personal login token" → Generate, y copia el token.
set -e
trap 'echo; echo "Si ha fallado, ejecuta: docker compose run --rm --no-deps --entrypoint rclone nubecine config --config /config/rclone.conf"' ERR
cd "$(dirname "$0")"
mkdir -p rclone
echo
echo "Pega tu token personal de Jottacloud (clic derecho para pegar) y pulsa Intro:"
read -r TOKEN
docker compose run --rm --no-deps --entrypoint rclone nubecine \
  config create jotta jottacloud config_type=standard config_login_token="$TOKEN" \
  --non-interactive --config /config/rclone.conf
echo
echo "==> Probando la conexión…"
docker compose run --rm --no-deps --entrypoint rclone nubecine lsd jotta: --config /config/rclone.conf || true
docker compose run --rm --no-deps --entrypoint rclone nubecine mkdir jotta:NubeCine/Peliculas --config /config/rclone.conf
docker compose run --rm --no-deps --entrypoint rclone nubecine mkdir jotta:NubeCine/Series --config /config/rclone.conf
docker compose restart nubecine
echo
echo "Listo. Sube tus vídeos a Jottacloud en NubeCine/Peliculas y NubeCine/Series"
echo "y pulsa 'Escanear ahora' en el panel Admin de la web."
