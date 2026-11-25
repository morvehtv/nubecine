#!/bin/bash
# Actualiza NubeCine en el VPS con la última versión de GitHub.
# Conserva tu configuración (.env), tus datos (data/) y la conexión con Jottacloud (rclone/).
# Uso:  bash ~/nubecine/actualizar.sh
set -e
REPO="${NUBECINE_REPO:-morvehtv/nubecine}"
DEST="${NUBECINE_DIR:-$HOME/nubecine}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> Descargando la última versión de github.com/$REPO…"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar xz -C "$TMP" --strip-components=1

echo "==> Copiando archivos (sin tocar .env, data/ ni rclone/)…"
mkdir -p "$DEST/server"
cp -r "$TMP/server/src" "$TMP/server/public" "$DEST/server/"
cp "$TMP/server/Dockerfile" "$TMP/server/start.sh" "$TMP/server/package.json" "$DEST/server/"
cp "$TMP"/docker-compose*.yml "$TMP/Caddyfile" "$TMP"/*.sh "$TMP/.env.example" "$TMP/README.md" "$DEST/"
chmod +x "$DEST"/*.sh "$DEST/server/start.sh"

echo "==> Reiniciando NubeCine…"
cd "$DEST"
docker compose up -d --build --force-recreate nubecine
echo
echo "Listo. NubeCine está actualizado."
