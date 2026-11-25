#!/bin/bash
# Lo ejecuta el sistema cada 2 minutos: si hay cambios en GitHub, actualiza NubeCine.
REPO="${NUBECINE_REPO:-morvehtv/nubecine}"
DIR="${NUBECINE_DIR:-/root/nubecine}"
exec 9>/tmp/nubecine-actualizar.lock
flock -n 9 || exit 0
SHA=$(git ls-remote "https://github.com/$REPO" refs/heads/main 2>/dev/null | cut -f1)
[ -z "$SHA" ] && SHA=$(curl -fsSL "https://api.github.com/repos/$REPO/commits/main" 2>/dev/null | grep -m1 '"sha"' | cut -d'"' -f4)
[ -z "$SHA" ] && exit 0
[ "$SHA" = "$(cat "$DIR/.version" 2>/dev/null)" ] && exit 0
echo "$(date '+%F %T') Nueva versión en GitHub: $SHA"
if NUBECINE_REPO="$REPO" NUBECINE_DIR="$DIR" bash "$DIR/actualizar.sh"; then
  echo "$SHA" > "$DIR/.version"
fi
