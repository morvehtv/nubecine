#!/bin/bash
# Actualiza NubeCine en el VPS con la última versión de GitHub.
# Conserva tu configuración (.env), tus datos (data/) y la conexión con Jottacloud (rclone/).
# Si solo cambia la web (diseño), no reinicia nada: las webs y apps abiertas se recargan solas.
# Uso:  bash ~/nubecine/actualizar.sh
# Todo va dentro de main(): bash lo lee entero antes de empezar, así puede sustituirse a sí mismo sin romperse
main() {
set -e
REPO="${NUBECINE_REPO:-morvehtv/nubecine}"
DEST="${NUBECINE_DIR:-$HOME/nubecine}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Huella de lo que obliga a reconstruir/reiniciar el servidor
huella() { (cd "$DEST" && cat server/src/*.js server/Dockerfile server/start.sh server/package.json docker-compose*.yml 2>/dev/null) | md5sum | cut -d' ' -f1; }
ANTES=$(huella)

echo "==> Descargando la última versión de github.com/$REPO…"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar xz -C "$TMP" --strip-components=1

echo "==> Copiando archivos (sin tocar .env, data/ ni rclone/)…"
mkdir -p "$DEST/server/public"
cp -r "$TMP/server/src" "$DEST/server/"
# La web se copia archivo a archivo para que se actualice en caliente
cp -r "$TMP/server/public/." "$DEST/server/public/"
cp "$TMP/server/Dockerfile" "$TMP/server/start.sh" "$TMP/server/package.json" "$DEST/server/"
cp "$TMP"/docker-compose*.yml "$TMP/Caddyfile" "$TMP"/*.sh "$TMP/.env.example" "$TMP/README.md" "$DEST/"
chmod +x "$DEST"/*.sh "$DEST/server/start.sh"

cd "$DEST"
if [ "$ANTES" != "$(huella)" ] || [ "${FORZAR:-}" = "1" ] || ! docker compose ps --status running nubecine 2>/dev/null | grep -q nubecine; then
  echo "==> Cambios en el servidor: reconstruyendo y reiniciando NubeCine…"
  docker compose up -d --build --force-recreate nubecine
else
  echo "==> Solo cambios de la web: no hace falta reiniciar (se recarga sola en los dispositivos)."
fi
echo
echo "Listo. NubeCine está actualizado."
}
main "$@"; exit $?
