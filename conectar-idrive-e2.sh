#!/bin/bash
# Cambia el almacenamiento de NubeCine de Jottacloud a IDrive e2.
# Uso en el VPS:  curl -fsSL https://raw.githubusercontent.com/morvehtv/nubecine/main/conectar-idrive-e2.sh | sudo bash
# Las claves se escriben aquí, en tu servidor; no se envían a ningún otro sitio.
main() {
  set -e
  DIR="${NUBECINE_DIR:-/root/nubecine}"
  cd "$DIR" || { echo "No encuentro la carpeta $DIR"; exit 1; }
  [ -f .env ] || { echo "No hay .env en $DIR"; exit 1; }
  preg() { local v; read -r -p "  $1: " v < /dev/tty; echo "$v"; }
  RC="docker compose run --rm --no-deps --entrypoint rclone nubecine --config /config/rclone.conf"

  echo
  echo "== Conectar IDrive e2"
  echo "  Los datos están en tu panel de IDrive e2 (app.idrivee2.com):"
  echo "   - Endpoint: en 'Regions', algo como  x1y2.par.idrivee2-23.com"
  echo "   - Claves: en 'Access Keys' → Create access key"
  echo
  ENDPOINT=$(preg "Endpoint (sin https://)"); ENDPOINT=${ENDPOINT#https://}; ENDPOINT=${ENDPOINT%/}
  KEY=$(preg "Access Key ID")
  read -r -s -p "  Secret Access Key (no se verá al escribir): " SECRET < /dev/tty; echo
  [ -n "$ENDPOINT" ] && [ -n "$KEY" ] && [ -n "$SECRET" ] || { echo "Faltan datos."; exit 1; }

  cp -a rclone/rclone.conf "rclone/rclone.conf.antes-e2-$(date +%F-%H%M)" 2>/dev/null || true
  $RC config create e2 s3 provider=IDrive access_key_id="$KEY" secret_access_key="$SECRET" endpoint="$ENDPOINT" --non-interactive >/dev/null
  unset SECRET

  echo
  echo "== Tus buckets en IDrive e2:"
  $RC lsd e2: || { echo "  No se pudo conectar: revisa el endpoint y las claves y vuelve a ejecutar."; exit 1; }
  echo
  BUCKET=$(preg "Nombre del bucket con las películas y series")
  echo "== Carpetas dentro de $BUCKET:"
  $RC lsd "e2:$BUCKET" || true
  echo "  Cada carpeta será una sección de la web (Películas, Series…)."
  CARPETA=$(preg "Carpeta que contiene esas secciones (Intro si están en la raíz del bucket)")
  CARPETA=${CARPETA#/}; CARPETA=${CARPETA%/}
  LIB="$BUCKET${CARPETA:+/$CARPETA}"
  echo "== Secciones que verá la web:"
  $RC lsd "e2:$LIB"

  cp .env ".env.antes-e2-$(date +%F-%H%M)"
  sed -i '/^RCLONE_REMOTE=/d;/^LIBRARY_PATH=/d;/^MOVIES_PATH=/d;/^SERIES_PATH=/d' .env
  printf 'RCLONE_REMOTE=e2:\nLIBRARY_PATH=%s\n' "$LIB" >> .env
  docker compose up -d --force-recreate nubecine >/dev/null
  echo
  echo "Listo. La web ahora lee de IDrive e2 ($LIB). En 1-2 minutos aparecerá el contenido."
  echo "Para volver a Jottacloud: cp $(ls -t .env.antes-e2-* | head -1) .env && docker compose up -d --force-recreate nubecine"
}
main "$@"; exit $?
