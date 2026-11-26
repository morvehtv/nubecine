#!/bin/bash
# Crea en IDrive e2 las mismas carpetas (secciones) que hay en Jottacloud, vacías.
# Uso en el VPS:  curl -fsSL https://raw.githubusercontent.com/morvehtv/nubecine/main/crear-carpetas-e2.sh | bash
main() {
  set -e
  cd "${NUBECINE_DIR:-/root/nubecine}"
  ORIGEN="${ORIGEN:-jotta:NubeCine}"
  DESTINO="${DESTINO:-e2:minube-idrive/Biblioteca}"
  echo "== Copiando la estructura de carpetas de $ORIGEN a $DESTINO (sin los vídeos)"
  docker compose run --rm --no-deps -e ORIGEN="$ORIGEN" -e DESTINO="$DESTINO" --entrypoint sh nubecine -c '
    R="rclone --config /config/rclone.conf"
    $R lsf --dirs-only "$ORIGEN" | while IFS= read -r d; do
      # S3 no guarda carpetas vacías: se crea un archivo oculto ".keep" para que existan
      $R touch "$DESTINO/${d}.keep" && echo "  creada: ${d%/}"
    done
    echo; echo "== Carpetas en $DESTINO:"; $R lsd "$DESTINO"
  '
}
main "$@"; exit $?
