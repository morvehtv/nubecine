# NubeCine

Web para ver tus películas y series guardadas en **Jottacloud**, con cuentas de usuario y app propia para **Android TV / Fire TV**.

- Catálogo automático: subes vídeos a Jottacloud, la web los detecta (cada hora o con «Escanear ahora»).
- Login con código de invitación. El primer usuario que se registra es el administrador.
- «Seguir viendo», «Mi lista», progreso por usuario, siguiente episodio automático, subtítulos `.srt`/`.vtt`.
- Panel de administración: escanear, editar títulos, sinopsis y carátulas, ocultar contenido, gestionar usuarios.
- Funciona con ratón, móvil (se puede instalar como app) y **mando de TV**.
- Sin dependencias: solo Node.js y rclone. Los vídeos nunca se descargan al servidor; se retransmiten desde la nube y solo a usuarios con sesión iniciada.

```
nubecine/
├── server/            ← la web (Node.js)
├── android-tv/        ← app para Android TV / Fire TV
├── docker-compose.yml ← despliegue con HTTPS
└── .github/workflows/ ← compila el APK en GitHub
```

---

## 1. Organiza tus vídeos en Jottacloud

Crea estas carpetas en Jottacloud (puedes cambiar los nombres en la configuración):

```
NubeCine/
├── Peliculas/
│   ├── El Viaje (2021)/
│   │   ├── El Viaje.mp4
│   │   ├── poster.jpg          ← opcional (carátula vertical)
│   │   ├── fondo.jpg           ← opcional (imagen horizontal)
│   │   └── El Viaje.es.srt     ← opcional (subtítulos; .es, .en…)
│   └── Noche Polar (2019).mp4  ← también vale un archivo suelto
└── Series/
    └── La Costa/
        ├── poster.jpg
        ├── Temporada 1/
        │   ├── S01E01 - Piloto.mp4
        │   └── S01E02 - La tormenta.mp4
        └── Temporada 2/
            └── S02E01.mp4
```

**Cada carpeta que crees dentro de `NubeCine` es una sección con su pestaña en el menú** (p. ej. `Peliculas Anime`, `Documentales`, `Series Anime`). Si el nombre lleva «Película/Movie» se trata como películas; si lleva «Serie/TV», como series; si no, se deduce por el contenido (episodios `S01E01`, carpetas `Temporada`…).

El año entre paréntesis y los episodios `S01E01`, `1x01` o `Episodio 1` se reconocen solos.

**Formato recomendado: MP4 con vídeo H.264 y audio AAC.** Es lo que reproducen todos los navegadores y teles. Los MKV con H.265/HEVC o audio DTS pueden no verse. Para convertir uno:

```bash
ffmpeg -i entrada.mkv -c:v libx264 -crf 20 -preset medium -c:a aac -b:a 192k -movflags +faststart salida.mp4
```

## 2. Conecta rclone a tu cuenta de Jottacloud

rclone es el programa que lee tu Jottacloud. Instálalo desde https://rclone.org/downloads/ y ejecuta:

```bash
rclone config
```

1. `n` (nuevo remoto) → nombre: **jotta**
2. Tipo: **jottacloud**
3. Método: **Standard authentication**
4. Entra en https://www.jottacloud.com/web/secure → «Personal login token» → **Generate**, copia el token y pégalo.
5. Dispositivo/punto de montaje no estándar: **No**.

Comprueba que funciona: `rclone lsd jotta:NubeCine`

> Cada sitio donde uses rclone necesita su propio token. Si copias `rclone.conf` a otro ordenador y lo usas en los dos a la vez, Jottacloud puede invalidarlo. Genera uno nuevo para el servidor.

El archivo de configuración queda en `~/.config/rclone/rclone.conf` (Windows: `%APPDATA%\rclone\rclone.conf`).

## 3. Pon la web en marcha

### Opción A — Servidor con dominio y HTTPS (recomendada)

En un VPS con Docker (Hetzner, OVH, etc.) y un dominio apuntando a su IP:

```bash
cd nubecine
mkdir -p rclone && cp ~/.config/rclone/rclone.conf rclone/   # o crea uno nuevo aquí
cp .env.example .env                                          # edita DOMAIN, INVITE_CODE...
docker compose up -d --build
```

Abre `https://tu-dominio`. Caddy pone el certificado HTTPS automáticamente.

### Opción B — En tu ordenador (pruebas o casa)

Requisitos: Node.js 18 o superior y rclone.

```bash
cd nubecine/server
cp config.example.json config.json   # edita inviteCode, carpetas...
./start.sh                           # Windows: iniciar-windows.bat
```

Abre http://localhost:3000. Para entrar desde la tele de casa usa la IP del ordenador (p. ej. `http://192.168.1.50:3000`).

### Primer acceso

1. Pulsa **Regístrate** y usa el código de invitación (aparece también en la consola al arrancar).
2. **El primer usuario es el administrador.**
3. Ve a **Admin → Escanear ahora**.
4. Para invitar a alguien, pásale la dirección y el código (Admin → Usuarios).

### Carátulas y sinopsis automáticas (opcional)

Crea una clave gratuita en https://www.themoviedb.org/settings/api y ponla en `TMDB_API_KEY` (o `tmdbApiKey` en `config.json`). Al escanear se rellenan póster, fondo, sinopsis y nota. Lo que edites a mano en el panel siempre tiene prioridad.

## 4. App para Android TV / Fire TV

La app abre tu web a pantalla completa en modo TV (todo se maneja con las flechas, OK, Atrás y los botones de reproducción del mando).

### Compilar el APK sin instalar nada (GitHub)

1. Sube la carpeta `nubecine` a un repositorio de GitHub (puede ser privado).
2. Pestaña **Actions → Compilar APK Android TV → Run workflow**.
3. Escribe la dirección de tu web (o déjalo vacío y la app la pedirá al abrirla).
4. Cuando termine, descarga **NubeCine-AndroidTV** en la parte de abajo (dentro está el `.apk`).

### Compilar con Android Studio

Abre la carpeta `android-tv` → **Build → Build APK(s)**. La dirección del servidor se puede fijar en `app/build.gradle.kts` o dejar que la app la pregunte.

### Instalar en la tele

- **Fire TV**: Ajustes → Mi Fire TV → Opciones para desarrolladores → activa «Apps de origen desconocido». Instala la app **Downloader**, escribe la URL donde hayas subido el APK y ábrelo.
- **Android TV / Google TV**: copia el APK a un USB y ábrelo con un gestor de archivos, o usa «Send Files to TV».
- **Con ordenador**: `adb connect IP_DE_LA_TELE` y `adb install NubeCine-AndroidTV.apk`.

Para cambiar el servidor más tarde: dentro de la app, **Cuenta → Cambiar servidor**.

## Cambiar el nombre

- Web: Admin → Ajustes → «Nombre de la web» (o `SITE_NAME`).
- App: `android-tv/app/src/main/res/values/strings.xml` y el banner en `res/drawable-xhdpi/banner.png` (320×180).

## Seguridad

- Contraseñas cifradas con scrypt; sesiones con cookie `HttpOnly`.
- rclone solo escucha en `127.0.0.1`: nadie de fuera puede acceder a tu Jottacloud.
- Bloqueo temporal tras varios intentos de login fallidos.
- Haz copias de `data/db.json` (usuarios, progreso y ediciones del catálogo).

Usa la web solo con contenido que te pertenezca o que tengas derecho a compartir.
