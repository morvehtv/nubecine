#!/bin/bash
# Blindaje del VPS (Ubuntu): cortafuegos para Docker, Fail2Ban, núcleo, SSH y actualizaciones automáticas.
# Hace copia de seguridad de todo lo que toca y no reinicia nada sin preguntar.
# Uso:  curl -fsSL https://raw.githubusercontent.com/morvehtv/nubecine/main/blindar-vps.sh | sudo bash
set -euo pipefail
main() {
  [ "$(id -u)" = 0 ] || { echo "Ejecútalo como root (sudo)."; exit 1; }
  FECHA=$(date +%F-%H%M)
  COPIA=/root/copia-blindaje-$FECHA
  mkdir -p "$COPIA"
  ok()   { echo -e "  \e[32m✔\e[0m $*"; }
  aviso(){ echo -e "  \e[33m!\e[0m $*"; }
  titulo(){ echo; echo -e "\e[1m== $*\e[0m"; }
  pregunta() { local r; read -r -p "  $1 [s/n] " r < /dev/tty || r=n; [[ "$r" =~ ^[sSyY] ]]; }

  titulo "Copia de seguridad en $COPIA"
  cp -a /etc/ufw /etc/ssh "$COPIA"/ 2>/dev/null || true
  [ -d /etc/fail2ban ] && cp -a /etc/fail2ban "$COPIA"/ || true
  ok "Hecha. Para deshacer: mira $COPIA"

  # ---------------------------------------------------------------- 1. Docker y UFW
  titulo "1/5 · Cortafuegos para los contenedores de Docker"
  if ! command -v docker >/dev/null || ! command -v ufw >/dev/null; then
    aviso "No hay Docker o UFW: se omite."
  else
    if grep -q "BEGIN BLINDAJE DOCKER-USER" /etc/ufw/after.rules; then
      ok "Las reglas ya estaban puestas."
    else
      cat >> /etc/ufw/after.rules <<'EOF'

# BEGIN BLINDAJE DOCKER-USER
*filter
:ufw-user-forward - [0:0]
:ufw-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -j ufw-user-forward
-A DOCKER-USER -j RETURN -s 10.0.0.0/8
-A DOCKER-USER -j RETURN -s 172.16.0.0/12
-A DOCKER-USER -j RETURN -s 192.168.0.0/16
-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A DOCKER-USER -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 172.16.0.0/12 -j ufw-docker-logging-deny
-A DOCKER-USER -p udp -m udp --dport 0:32767 -d 172.16.0.0/12 -j ufw-docker-logging-deny
-A DOCKER-USER -j RETURN
-A ufw-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "
-A ufw-docker-logging-deny -j DROP
COMMIT
# END BLINDAJE DOCKER-USER
EOF
      ok "Reglas base añadidas."
    fi

    # Puertos que Docker publica hoy (puerto del servidor -> puerto dentro del contenedor)
    mapfile -t PUB < <(docker ps --format '{{.Names}}|{{.Ports}}' | tr ',' '\n' | sed -nE 's/.*\|?\s*0\.0\.0\.0:([0-9]+)->([0-9]+)\/tcp.*/\1 \2/p' | sort -u)
    CF_80_443=n
    for linea in "${PUB[@]}"; do
      ext=${linea% *}; int=${linea#* }
      if [ "$ext" = 80 ] || [ "$ext" = 443 ]; then
        [ "$CF_80_443" = n ] && {
          echo "  Los puertos 80/443 son de un contenedor (BTCPay)."
          if pregunta "¿Su dominio tiene la nube NARANJA de Cloudflare (pasa por Cloudflare)? Si no lo sabes, contesta n"; then CF_80_443=si; else CF_80_443=todos; fi
        }
        if [ "$CF_80_443" = si ]; then
          for ip in $(curl -fsS https://www.cloudflare.com/ips-v4); do ufw route allow proto tcp from "$ip" to any port "$int" comment 'Cloudflare a Docker' >/dev/null; done
          ok "Puerto $ext: solo desde Cloudflare."
        else
          ufw route allow proto tcp from any to any port "$int" comment "Docker $ext" >/dev/null
          ok "Puerto $ext: abierto a todos (como hasta ahora)."
        fi
      else
        ufw route allow proto tcp from any to any port "$int" comment "Docker $ext" >/dev/null
        ok "Puerto $ext (contenedor $int): abierto (la propia aplicación filtra)."
      fi
    done
    ufw reload >/dev/null
    ok "Cortafuegos recargado. Cualquier otro puerto que publique Docker en el futuro quedará cerrado hasta que lo permitas."
  fi

  # ---------------------------------------------------------------- 2. Fail2Ban
  titulo "2/5 · Fail2Ban (bloquea a quien intenta adivinar contraseñas)"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban >/dev/null
  cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd
banaction = ufw
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
mode    = aggressive

[recidive]
enabled  = true
backend  = auto
logpath  = /var/log/fail2ban.log
bantime  = 1w
findtime = 1d
maxretry = 3
EOF
  touch /var/log/fail2ban.log
  systemctl enable --now fail2ban >/dev/null 2>&1; systemctl restart fail2ban
  sleep 2; fail2ban-client status sshd >/dev/null && ok "Activo: 5 fallos en 10 min = 1 hora bloqueado; reincidentes, 1 semana."

  # ---------------------------------------------------------------- 3. Núcleo
  titulo "3/5 · Protección de red del sistema"
  cat > /etc/sysctl.d/99-blindaje.conf <<'EOF'
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.tcp_synack_retries = 3
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.conf.all.log_martians = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
EOF
  sysctl --system >/dev/null && ok "Aplicada (contra inundaciones SYN y paquetes falsificados)."

  # ---------------------------------------------------------------- 4. SSH
  titulo "4/5 · SSH"
  cat > /etc/ssh/sshd_config.d/01-blindaje-basico.conf <<'EOF'
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
  if sshd -t; then systemctl reload ssh; ok "Máximo 3 intentos por conexión y 20 s para identificarse."; else rm -f /etc/ssh/sshd_config.d/01-blindaje-basico.conf; aviso "No se aplicó (la configuración no era válida)."; fi
  if [ -s /root/.ssh/authorized_keys ] && pregunta "¿Entras ya al VPS con CLAVE SSH (sin escribir la contraseña del servidor)?"; then
    cat > /etc/ssh/sshd_config.d/00-blindaje.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
    if sshd -t; then systemctl reload ssh; ok "Contraseñas desactivadas: solo se entra con clave."
      aviso "NO cierres esta ventana: abre otra y comprueba que entras. Si no: rm /etc/ssh/sshd_config.d/00-blindaje.conf && systemctl reload ssh"
    else rm -f /etc/ssh/sshd_config.d/00-blindaje.conf; aviso "No se aplicó."; fi
  else
    aviso "Sigues entrando con contraseña: Fail2Ban te protege, pero lo más seguro es pasar a clave SSH (Paso 1 de la guía)."
  fi

  # ---------------------------------------------------------------- 5. Actualizaciones
  titulo "5/5 · Actualizaciones de seguridad automáticas"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null
  echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades
  ok "Activadas (se instalan solas cada día)."

  # ---------------------------------------------------------------- Resumen
  titulo "Comprobación"
  printf "  %-12s %s\n" ssh "$(systemctl is-active ssh)" fail2ban "$(systemctl is-active fail2ban)" docker "$(systemctl is-active docker 2>/dev/null)" cloudflared "$(systemctl is-active cloudflared 2>/dev/null)"
  docker ps --format '  {{.Names}}: {{.Status}}' 2>/dev/null | head -12
  echo
  if [ -f /var/run/reboot-required ]; then
    aviso "El sistema necesita reiniciarse para aplicar actualizaciones del núcleo."
    if pregunta "¿Reiniciar ahora? (los contenedores y el túnel vuelven solos en 1-2 minutos)"; then echo "  Reiniciando…"; sleep 2; reboot; fi
    echo "  Puedes reiniciar más tarde con: reboot"
  fi
  echo; echo -e "\e[1mListo.\e[0m Copia de seguridad en $COPIA"
}
main "$@"; exit $?
