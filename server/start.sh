#!/bin/sh
# Arranca rclone (conectado a Jottacloud) y la web.
cd "$(dirname "$0")"

if [ "${STORAGE:-rclone}" != "local" ]; then
  if [ -n "$RCLONE_CONFIG" ] && [ ! -f "$RCLONE_CONFIG" ]; then
    echo "AVISO: falta la configuración de rclone en $RCLONE_CONFIG."
    echo "La web arranca igualmente, pero no verá vídeos hasta que conectes Jottacloud (ver README, paso 2)."
  else
    # Solo escucha en local: nadie de fuera puede hablar con rclone directamente
    rclone rcd --rc-serve --rc-no-auth --rc-addr 127.0.0.1:5572 \
      --buffer-size 32M --contimeout 30s --timeout 5m --low-level-retries 5 &
    sleep 2
  fi
fi

exec node src/server.js
