'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const DB = require('./db');
const { createStorage } = require('./storage');
const { buildLibrary, mergeCatalog, enrichWithTMDB, EDITABLE } = require('./scanner');
const { ffprobe, ffprobeAvailable, pickCastellano, audioLabel } = require('./probe');
const { GeoDB, Guard, normalizeIp, isPrivate } = require('./security');

// ---------- Configuración ----------
const ROOT = path.resolve(__dirname, '..');
const cfgFile = process.env.CONFIG || path.join(ROOT, 'config.json');
const fileCfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const cfg = {
  siteName: 'NubeCine',
  port: 3000,
  storage: 'rclone',               // 'rclone' o 'local'
  rcloneUrl: 'http://127.0.0.1:5572',
  remote: 'jotta:',
  rcloneUser: '', rclonePass: '',
  localPath: './media',
  moviesPath: 'NubeCine/Peliculas',
  seriesPath: 'NubeCine/Series',
  libraryPath: '',                // carpeta raíz: cada subcarpeta es una sección
  inviteCode: '',
  tmdbApiKey: '',
  dataFile: './data/db.json',
  autoScanMinutes: 1,
  ...fileCfg,
};
for (const [k, env] of Object.entries({
  siteName: 'SITE_NAME', port: 'PORT', storage: 'STORAGE', rcloneUrl: 'RCLONE_URL', remote: 'RCLONE_REMOTE',
  rcloneUser: 'RCLONE_USER', rclonePass: 'RCLONE_PASS', localPath: 'LOCAL_PATH', moviesPath: 'MOVIES_PATH',
  seriesPath: 'SERIES_PATH', autoScanMinutes: 'AUTO_SCAN_MINUTES', libraryPath: 'LIBRARY_PATH', inviteCode: 'INVITE_CODE', tmdbApiKey: 'TMDB_API_KEY', dataFile: 'DATA_FILE',
})) if (process.env[env]) cfg[k] = process.env[env];
cfg.port = parseInt(cfg.port, 10);
// Si no se indica, la raíz es la carpeta que contiene la de películas (NubeCine)
if (!cfg.libraryPath) cfg.libraryPath = cfg.moviesPath.split('/').slice(0, -1).join('/') || cfg.moviesPath;

const db = new DB(path.resolve(ROOT, cfg.dataFile));
const storage = createStorage({ ...cfg, localPath: path.resolve(ROOT, cfg.localPath) });
const D = db.data;
// Web privada: solo estos usuarios pueden entrar (se cambia en Admin → Ajustes o con ALLOWED_USERS en .env)
if (process.env.ALLOWED_USERS !== undefined) D.settings.allowedUsers = process.env.ALLOWED_USERS.split(/[,\s]+/).filter(Boolean);
else if (!Array.isArray(D.settings.allowedUsers)) D.settings.allowedUsers = ['Jairobiix', 'luci88ct'];
const userAllowed = (name) => { const l = D.settings.allowedUsers || []; return !l.length || l.some((x) => x.toLowerCase() === String(name || '').toLowerCase()); };
if (D.settings.requireApproval !== true) for (const u of D.users || []) if (u.approved === false) u.approved = true;
// Administrador fijo: si ADMIN_USER está definido, solo ese usuario es administrador
const ADMIN_USER = String(process.env.ADMIN_USER || cfg.adminUser || '').trim().toLowerCase();
if (ADMIN_USER) { for (const u of D.users) u.admin = u.username.toLowerCase() === ADMIN_USER; db.save(); }
if (!D.settings.inviteCode) {
  D.settings.inviteCode = cfg.inviteCode || crypto.randomBytes(4).toString('hex');
  db.save();
}
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

// ---------- Utilidades HTTP ----------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',  // que no aparezca en buscadores
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(data);
}
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('JSON no válido')); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
// IP del visitante. Solo se aceptan cabeceras de proxy si se ha indicado que hay uno delante (TRUST_PROXY=1 / cloudflare)
const TRUST_PROXY = (process.env.TRUST_PROXY || '').toLowerCase();
function clientIp(req) {
  const direct = normalizeIp(req.socket.remoteAddress);
  if (TRUST_PROXY && isPrivate(direct)) {
    const h = TRUST_PROXY === 'cloudflare' ? req.headers['cf-connecting-ip'] : (req.headers['x-forwarded-for'] || '').split(',')[0];
    if (h) return normalizeIp(h);
  }
  return direct;
}
// País que indica Cloudflare (más preciso que la base de datos propia). Solo si la petición llega por el túnel.
function cfCountry(req) {
  if (TRUST_PROXY !== 'cloudflare' || !isPrivate(normalizeIp(req.socket.remoteAddress))) return '';
  const c = String(req.headers['cf-ipcountry'] || '').toUpperCase();
  return /^[A-Z][A-Z0-9]$/.test(c) && c !== 'XX' ? c : '';
}

// ---------- Usuarios y sesiones ----------
const hashPass = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const passOk = (u, pw) => crypto.timingSafeEqual(Buffer.from(hashPass(String(pw || ''), u.salt), 'hex'), Buffer.from(u.passHash, 'hex'));
// Las sesiones se guardan cifradas (hash del token): si alguien leyera la base de datos no podría usarlas
const tokenKey = (t) => 'h:' + crypto.createHash('sha256').update(String(t)).digest('hex');
function deviceName(ua = '') {
  const os = /Android TV|AFT|GoogleTV|BRAVIA|SmartTV/i.test(ua) ? 'Tele' : /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Dispositivo';
  const app = /NubeCineApp/i.test(ua) ? 'app' : /Edg\//.test(ua) ? 'Edge' : /Firefox/i.test(ua) ? 'Firefox' : /CriOS|Chrome/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : 'navegador';
  return `${os} · ${app}`;
}
function newSession(res, req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  D.sessions[tokenKey(token)] = { userId: user.id, expires: now + 1000 * 60 * 60 * 24 * 60, created: now, last: now, ip: clientIp(req), device: deviceName(req.headers['user-agent']) };
  user.lastLogin = { at: new Date().toISOString(), ip: clientIp(req) };
  db.save();
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 60}; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}
function sessionOf(req) {
  const token = cookies(req).sid || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return null;
  let key = tokenKey(token);
  if (!D.sessions[key] && D.sessions[token]) { D.sessions[key] = D.sessions[token]; delete D.sessions[token]; db.save(); } // sesiones antiguas
  const s = D.sessions[key];
  if (!s) return null;
  // Caduca a los 60 días, o antes si el aparato lleva 30 días sin usarse
  if (s.expires < Date.now() || Date.now() - (s.last || s.created || 0) > 30 * 24 * 3600 * 1000) { delete D.sessions[key]; db.save(); return null; }
  if (Date.now() - (s.last || 0) > 10 * 60 * 1000) { s.last = Date.now(); s.ip = clientIp(req); db.save(); }
  return { key, s };
}
function currentUser(req) {
  const ses = sessionOf(req);
  if (!ses) return null;
  const u = D.users.find((x) => x.id === ses.s.userId) || null;
  if (u && !userAllowed(u.username)) { delete D.sessions[ses.key]; db.save(); return null; } // ya no tiene acceso
  return u && u.approved === false ? null : u;
}
const publicUser = (u) => ({ id: u.id, username: u.username, admin: !!u.admin, twoFactor: !!(u.totp && u.totp.enabled) });

// Contraseñas: mínimo 8 caracteres y que no sea de las típicas
const COMMON_PW = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'contraseña', 'qwertyui', 'qwerty123', '11111111', '00000000', '12341234', 'abcd1234', 'iloveyou', 'aaaaaaaa', 'abc12345', 'admin123', 'administrador', 'teamo123', 'barcelona', 'realmadrid', 'netflix1', 'pelicula', 'peliculas', '87654321', 'zxcvbnm1', 'asdfghjk', '1q2w3e4r', 'passw0rd']);
function passwordProblem(pw, username) {
  pw = String(pw || '');
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (COMMON_PW.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return 'Esa contraseña es demasiado fácil de adivinar.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'La contraseña no puede contener tu nombre de usuario.';
  return null;
}

// Verificación en dos pasos (TOTP, compatible con Google Authenticator, Authy, Microsoft Authenticator…)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); let o = ''; for (let i = 0; i + 5 <= bits.length; i += 5) o += B32[parseInt(bits.slice(i, i + 5), 2)]; return o; }
function b32dec(str) { let bits = ''; for (const c of String(str).replace(/[=\s]/g, '').toUpperCase()) { const v = B32.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); } const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); }
function totpCode(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function totpOk(user, code) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code) || !user.totp) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) {
    const st = step + d;
    if (st > (user.totp.lastStep || 0) && crypto.timingSafeEqual(Buffer.from(totpCode(user.totp.secret, st)), Buffer.from(code))) {
      user.totp.lastStep = st; // un código no se puede reutilizar
      return true;
    }
  }
  return false;
}

// Registro de accesos (últimos 300)
function logAccess(req, username, result) {
  const ip = clientIp(req);
  D.accessLog = D.accessLog || [];
  D.accessLog.unshift({ at: new Date().toISOString(), user: String(username || '').slice(0, 40), ip, result, device: deviceName(req.headers['user-agent']) });
  D.accessLog.length = Math.min(D.accessLog.length, 300);
  db.save();
}
const userFails = new Map(); // usuario -> {n, until}: 10 fallos = cuenta bloqueada 15 min

const attempts = new Map(); // ip -> {n, until}
// Freno por IP: 15 intentos FALLIDOS (contraseña o código incorrecto) = 10 minutos bloqueada
function tooMany(req) { const a = attempts.get(clientIp(req)); return !!(a && a.until > Date.now()); }
function ipFail(req) {
  const ip = clientIp(req);
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (++a.n >= 15) { a.until = Date.now() + 10 * 60 * 1000; a.n = 0; }
  attempts.set(ip, a);
}

// ---------- Catálogo ----------
function view(t) {
  const pick = (k) => (t.edited && k in t.edited ? t.edited[k] : (t.meta && t.meta[k] != null ? t.meta[k] : t[k]));
  const poster = pick('posterUrl') || (t.posterFile ? '/img/' + t.posterFile : null);
  const backdrop = pick('backdropUrl') || (t.backdropFile ? '/img/' + t.backdropFile : null);
  const out = {
    id: t.id, type: t.type, section: t.section || (t.type === 'movie' ? 'Peliculas' : 'Series'), title: pick('title'), year: pick('year'), overview: pick('overview') || '',
    rating: pick('rating') || null, genres: pick('genres') || [], poster, backdrop, addedAt: t.addedAt,
  };
  if (t.saga) out.saga = true;
  if (t.type === 'series') {
    const seasons = Object.keys(t.seasons || {}).map(Number).sort((a, b) => a - b);
    out.seasonCount = seasons.length;
    out.episodeCount = seasons.reduce((n, s) => n + t.seasons[s].length, 0);
  }
  return out;
}
const visibleTitles = () => Object.values(D.titles).filter((t) => !(t.edited && t.edited.hidden));

function allEpisodes(t) {
  return Object.keys(t.seasons).map(Number).sort((a, b) => a - b).flatMap((s) => t.seasons[s]);
}
function findFileOwner(fileId) {
  for (const t of Object.values(D.titles)) {
    if (t.type === 'movie' && t.fileId === fileId) return { title: t, episode: null };
    if (t.type === 'series') for (const e of allEpisodes(t)) if (e.fileId === fileId) return { title: t, episode: e };
  }
  return null;
}

function continueWatching(userId) {
  const prog = D.progress[userId] || {};
  const byTitle = new Map();
  for (const [fileId, p] of Object.entries(prog)) {
    const cur = byTitle.get(p.titleId);
    if (!cur || cur.at < p.at) byTitle.set(p.titleId, { fileId, ...p });
  }
  const out = [];
  for (const p of [...byTitle.values()].sort((a, b) => b.at - a.at)) {
    const t = D.titles[p.titleId];
    if (!t || (t.edited && t.edited.hidden)) continue;
    const done = p.d && p.t / p.d > 0.93;
    if (t.type === 'movie') {
      if (!done) out.push({ ...view(t), fileId: p.fileId, t: p.t, d: p.d });
    } else {
      const eps = allEpisodes(t);
      const i = eps.findIndex((e) => e.fileId === p.fileId);
      if (i < 0) continue;
      const ep = done ? eps[i + 1] : eps[i];
      if (!ep) continue;
      const pp = prog[ep.fileId];
      out.push({ ...view(t), fileId: ep.fileId, season: ep.season, episode: ep.episode, t: done ? (pp?.t || 0) : p.t, d: done ? (pp?.d || 0) : p.d });
    }
    if (out.length >= 20) break;
  }
  return out;
}

// ---------- Análisis de pistas de audio (castellano por defecto) ----------
// D.media[fileId] = { key, audio: [{lang,title,codec,channels,default}], pref: ordinal|null, error? }
async function probeOne(id) {
  const f = D.files[id];
  if (!f || f.kind !== 'video') return;
  const key = `${f.path}|${f.size}`;
  try {
    const { audio, video, duration, container } = await ffprobe(storage.probeUrl(f.root, f.path));
    D.media[id] = { key, audio, video, duration, container, pref: pickCastellano(audio) };
  } catch (e) {
    D.media[id] = { key, audio: [], pref: null, error: String(e.message || e).slice(0, 200) };
  }
}
const needsProbe = (id) => { const f = D.files[id], m = (D.media || {})[id]; return !m || m.key !== `${f.path}|${f.size}` || m.video === undefined; };
let probing = false;
async function probeAll() {
  if (probing || !(await ffprobeAvailable())) return;
  probing = true;
  D.media = D.media || {};
  try {
    const todo = Object.entries(D.files).filter(([id, f]) => f.kind === 'video' && (!D.media[id] || D.media[id].key !== `${f.path}|${f.size}` || (D.media[id].video === undefined && !D.media[id].error)));
    if (todo.length) log(`Analizando audio de ${todo.length} vídeo(s)…`);
    let n = 0;
    const worker = async () => {
      while (todo.length) {
        const [id] = todo.shift();
        if (!needsProbe(id)) continue; // ya lo analizó la reproducción
        await probeOne(id);
        if (++n % 5 === 0) db.save();
      }
    };
    await Promise.all([worker(), worker()]);
    // Limpia análisis de vídeos que ya no existen
    for (const id of Object.keys(D.media)) if (!D.files[id]) delete D.media[id];
    db.save();
    if (n) log(`Audio analizado en ${n} vídeo(s)`);
  } finally { probing = false; }
}
function audioInfo(fileId) {
  const m = (D.media || {})[fileId];
  const media = m ? { container: m.container || '', video: m.video || null } : null;
  if (!m || !m.audio || !m.audio.length) return { audio: [], prefAudio: null, duration: (m && m.duration) || 0, media };
  const audio = m.audio.map((a, i) => ({ n: i, label: audioLabel(a), lang: a.lang, title: a.title, codec: a.codec, default: a.default }));
  // Si dos pistas se llaman igual, se numeran ("Castellano 2")
  const seen = {};
  for (const a of audio) { seen[a.label] = (seen[a.label] || 0) + 1; if (seen[a.label] > 1) a.label += ' ' + seen[a.label]; }
  return { audio, prefAudio: m.pref, duration: m.duration || 0, media };
}

// ---------- Tiempo real: avisos a las webs/apps abiertas (Server-Sent Events) ----------
const liveClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of liveClients) { try { c.write(msg); } catch {} }
}
// Firma del catálogo: cambia si hay títulos nuevos, borrados o con otros datos (carátulas, nombres…)
function catalogSignature() {
  const all = Object.values(D.titles).map((t) => JSON.stringify([view(t), t.type === 'series' ? Object.values(t.seasons).flat().map((e) => e.fileId) : t.fileId, !!(t.edited && t.edited.hidden)])).sort();
  return crypto.createHash('sha1').update(all.join('|') + JSON.stringify(D.sections || [])).digest('hex');
}
function catalogChanged(addedIds = []) {
  const sig = catalogSignature();
  if (sig === D.catalogSig) return;
  D.catalogSig = sig;
  D.catalogVersion = (D.catalogVersion || 0) + 1;
  db.save();
  const added = addedIds.map((id) => D.titles[id]).filter((t) => t && !(t.edited && t.edited.hidden)).map((t) => view(t).title);
  broadcast('catalog', { version: D.catalogVersion, added: added.slice(0, 5), addedCount: added.length });
}
// Versión de la web: huella de los archivos de public/. Si cambian (actualización), las webs abiertas se recargan.
let webVersion = '';
function computeWebVersion() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f); else { h.update(e.name); h.update(fs.readFileSync(f)); }
    }
  };
  try { walk(path.join(ROOT, 'public')); } catch {}
  return h.digest('hex').slice(0, 12);
}
webVersion = computeWebVersion();
setInterval(() => {
  const v = computeWebVersion();
  if (v !== webVersion) { webVersion = v; log('Web actualizada: versión', v); broadcast('version', { version: v }); }
}, 15000).unref();

let scanning = null;
// Huella de la lista de archivos: si no cambia, no hace falta rehacer el catálogo
let lastSig = '';
const sigOf = (all) => crypto.createHash('sha1').update(all.map((f) => `${f.path}|${f.size}|${f.mtime}`).sort().join('\n')).digest('hex');
async function scan(force = true) {
  if (scanning) return scanning;
  scanning = (async () => {
    const t0 = Date.now();
    const all = await storage.list(cfg.libraryPath);
    const sig = sigOf(all);
    if (!force && sig === lastSig) return D.lastScan; // nada nuevo en la nube
    lastSig = sig;
    const before = new Set(Object.keys(D.titles));
    const fresh = buildLibrary(all, cfg.libraryPath);
    D.titles = mergeCatalog(D.titles, fresh.titles);
    D.files = fresh.files;
    D.sections = fresh.sections;
    const enriched = await enrichWithTMDB(D.titles, cfg.tmdbApiKey, log);
    D.lastScan = { at: new Date().toISOString(), ms: Date.now() - t0, files: all.length, sections: fresh.sections.length, titles: Object.keys(D.titles).length, enriched };
    db.save();
    log('Escaneo completado:', JSON.stringify(D.lastScan));
    catalogChanged(Object.keys(D.titles).filter((id) => !before.has(id)));
    probeAll().catch((e) => log('Análisis de audio falló:', e.message));
    return D.lastScan;
  })().finally(() => { scanning = null; });
  return scanning;
}

// ---------- Rutas ----------
const routes = [];
const route = (method, pattern, opts, handler) => {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, ...opts });
};

// Enlace corto para instalar la app (p. ej. en Downloader): http://SERVIDOR/app -> última versión en GitHub
const APP_REPO = process.env.APP_REPO || cfg.appRepo || 'morvehtv/nubecine';
for (const p of ['/app', '/apk', '/app.apk']) {
  route('GET', p, (req, res) => {
    res.writeHead(302, { Location: `https://github.com/${APP_REPO}/releases/latest/download/NubeCine.apk`, 'Cache-Control': 'no-cache' });
    res.end();
  });
}

route('GET', '/robots.txt', (req, res) => send(res, 200, 'User-agent: *\nDisallow: /\n'));

route('GET', '/api/config', (req, res) => send(res, 200, { siteName: D.settings.siteName || cfg.siteName, requireInvite: !!D.settings.requireInvite }));

route('POST', '/api/register', async (req, res) => {
  if (tooMany(req)) return fail(res, 429, 'Demasiados intentos. Espera unos minutos.');
  const { username, password, inviteCode } = await readBody(req);
  const name = String(username || '').trim();
  if (!/^[\w.\-áéíóúñÁÉÍÓÚÑ]{3,30}$/.test(name)) return fail(res, 400, 'El usuario debe tener entre 3 y 30 letras o números.');
  const pwProblem = passwordProblem(password, name);
  if (pwProblem) return fail(res, 400, pwProblem);
  if (D.settings.requireInvite && String(inviteCode || '').trim() !== D.settings.inviteCode) return fail(res, 403, 'El código de invitación no es correcto.');
  if (!userAllowed(name)) { logAccess(req, name, 'registro rechazado (web privada)'); ipFail(req); return fail(res, 403, 'Esta web es privada. No se pueden crear cuentas nuevas.'); }
  if (D.users.some((u) => u.username.toLowerCase() === name.toLowerCase())) return fail(res, 409, 'Ese usuario ya existe.');
  if (D.users.length && guard.count('reg:' + clientIp(req), 3, 24 * 3600 * 1000)) return fail(res, 429, 'Se han creado demasiadas cuentas desde esta conexión hoy.');
  const salt = crypto.randomBytes(16).toString('hex');
  const admin = ADMIN_USER ? name.toLowerCase() === ADMIN_USER : D.users.length === 0;
  // Cuentas nuevas pendientes de aprobación del administrador (si está activado)
  const approved = admin || D.settings.requireApproval !== true; // desactivado salvo que se active en Ajustes
  const user = { id: crypto.randomUUID(), username: name, salt, passHash: hashPass(password, salt), admin, approved, createdAt: new Date().toISOString() };
  D.users.push(user); db.save();
  logAccess(req, name, approved ? 'registro' : 'registro (pendiente)');
  if (!approved) return send(res, 200, { pending: true });
  newSession(res, req, user);
  send(res, 200, publicUser(user));
});

route('POST', '/api/login', async (req, res) => {
  if (tooMany(req)) return fail(res, 429, 'Demasiados intentos. Espera unos minutos.');
  const { username, password, code } = await readBody(req);
  const uname = String(username || '').trim().toLowerCase();
  const lock = userFails.get(uname);
  if (lock && lock.until > Date.now()) { logAccess(req, username, 'cuenta bloqueada'); return fail(res, 429, 'Demasiados intentos fallidos en esta cuenta. Espera 15 minutos.'); }
  const u = D.users.find((x) => x.username.toLowerCase() === uname);
  if (!u || !passOk(u, password) || !userAllowed(u.username)) {
    const f = userFails.get(uname) || { n: 0, until: 0 };
    if (++f.n >= 10) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; }
    userFails.set(uname, f);
    logAccess(req, username, 'contraseña incorrecta'); ipFail(req);
    return fail(res, 401, 'Usuario o contraseña incorrectos.');
  }
  if (u.approved === false) { logAccess(req, u.username, 'pendiente de aprobación'); return fail(res, 403, 'Tu cuenta aún no ha sido aprobada por el administrador.'); }
  if (u.totp && u.totp.enabled) {
    if (!code) return send(res, 401, { need2fa: true, error: 'Escribe el código de tu app de autenticación.' });
    if (!totpOk(u, code)) { logAccess(req, u.username, 'código 2FA incorrecto'); ipFail(req); return send(res, 401, { need2fa: true, error: 'El código no es correcto.' }); }
  }
  userFails.delete(uname);
  newSession(res, req, u);
  logAccess(req, u.username, 'correcto');
  send(res, 200, publicUser(u));
});

route('POST', '/api/logout', (req, res) => {
  const ses = sessionOf(req); if (ses) { delete D.sessions[ses.key]; db.save(); }
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  send(res, 200, { ok: true });
});

route('GET', '/api/events', { auth: true }, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`retry: 4000\nevent: hello\ndata: ${JSON.stringify({ version: webVersion, catalog: D.catalogVersion || 0 })}\n\n`);
  liveClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); liveClients.delete(res); });
});

route('GET', '/api/me', { auth: true }, (req, res, p, user) => {
  // Renueva la cookie con SameSite=Lax (una versión anterior usaba Strict, que en iPhone deja de enviarse)
  const token = cookies(req).sid; const ses = sessionOf(req);
  if (token && ses) res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${Math.max(60, Math.floor((ses.s.expires - Date.now()) / 1000))}; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
  send(res, 200, publicUser(user));
});

route('POST', '/api/password', { auth: true }, async (req, res, p, user) => {
  const { current, next } = await readBody(req);
  if (!passOk(user, current)) return fail(res, 401, 'La contraseña actual no es correcta.');
  const problem = passwordProblem(next, user.username); if (problem) return fail(res, 400, problem);
  user.salt = crypto.randomBytes(16).toString('hex'); user.passHash = hashPass(next, user.salt);
  const mine = sessionOf(req);
  for (const [k, s] of Object.entries(D.sessions)) if (s.userId === user.id && (!mine || k !== mine.key)) delete D.sessions[k];
  db.save();
  send(res, 200, { ok: true });
});

// Mis dispositivos conectados
route('GET', '/api/sessions', { auth: true }, (req, res, p, user) => {
  const mine = sessionOf(req);
  send(res, 200, Object.entries(D.sessions).filter(([, s]) => s.userId === user.id)
    .map(([k, s]) => ({ id: k.slice(2, 14), current: !!mine && k === mine.key, device: s.device || 'Dispositivo', ip: s.ip || '', last: s.last || s.created || null }))
    .sort((a, b) => (b.current - a.current) || ((b.last || 0) - (a.last || 0))));
});
route('POST', '/api/sessions/logout-others', { auth: true }, (req, res, p, user) => {
  const mine = sessionOf(req); let n = 0;
  for (const [k, s] of Object.entries(D.sessions)) if (s.userId === user.id && (!mine || k !== mine.key)) { delete D.sessions[k]; n++; }
  db.save(); send(res, 200, { closed: n });
});

// Verificación en dos pasos
route('POST', '/api/2fa/setup', { auth: true }, (req, res, p, user) => {
  if (user.totp && user.totp.enabled) return fail(res, 400, 'Ya está activada.');
  const secret = b32enc(crypto.randomBytes(20));
  user.totp = { secret, enabled: false };
  db.save();
  const issuer = encodeURIComponent(D.settings.siteName || cfg.siteName);
  send(res, 200, { secret, url: `otpauth://totp/${issuer}:${encodeURIComponent(user.username)}?secret=${secret}&issuer=${issuer}&digits=6&period=30` });
});
route('POST', '/api/2fa/enable', { auth: true }, async (req, res, p, user) => {
  const { code } = await readBody(req);
  if (!user.totp || !user.totp.secret) return fail(res, 400, 'Primero genera la clave.');
  if (!totpOk(user, code)) return fail(res, 400, 'El código no es correcto. Comprueba que la hora del móvil es la correcta.');
  user.totp.enabled = true; db.save();
  send(res, 200, { ok: true });
});
route('POST', '/api/2fa/disable', { auth: true }, async (req, res, p, user) => {
  const { password, code } = await readBody(req);
  if (!passOk(user, password)) return fail(res, 401, 'La contraseña no es correcta.');
  if (user.totp && user.totp.enabled && !totpOk(user, code)) return fail(res, 401, 'El código no es correcto.');
  delete user.totp; db.save();
  send(res, 200, { ok: true });
});

route('GET', '/api/catalog', { auth: true }, (req, res, p, user) => {
  const items = visibleTitles().map(view);
  const mine = new Set(D.mylist[user.id] || []);
  send(res, 200, {
    items,
    continue: continueWatching(user.id),
    mylist: items.filter((t) => mine.has(t.id)),
    sections: (D.sections || []).filter((s) => items.some((t) => t.section === s.id)),
    lastScan: D.lastScan,
  });
});

route('GET', '/api/title/:id', { auth: true }, (req, res, p, user) => {
  const t = D.titles[p.id];
  if (!t) return fail(res, 404, 'No encontrado');
  const prog = D.progress[user.id] || {};
  const out = { ...view(t), inList: (D.mylist[user.id] || []).includes(t.id) };
  if (t.type === 'movie') {
    out.fileId = t.fileId; out.subs = t.subs; out.progress = prog[t.fileId] || null;
    out.audio = audioInfo(t.fileId).audio.map((a) => a.label);
  } else {
    out.seasons = Object.keys(t.seasons).map(Number).sort((a, b) => a - b).map((s) => ({
      season: s,
      episodes: t.seasons[s].map((e) => ({ ...e, progress: prog[e.fileId] || null, audio: audioInfo(e.fileId).audio.map((a) => a.label) })),
    }));
  }
  send(res, 200, out);
});

route('GET', '/api/play/:fileId', { auth: true }, async (req, res, p, user) => {
  const own = findFileOwner(p.fileId);
  if (!own) return fail(res, 404, 'No encontrado');
  if (needsProbe(p.fileId) && (await ffprobeAvailable())) {
    D.media = D.media || {};
    await Promise.race([probeOne(p.fileId), new Promise((r) => setTimeout(r, 25000))]);
    db.save();
  }
  const { title: t, episode: e } = own;
  let next = null;
  if (e) {
    const eps = allEpisodes(t); const i = eps.findIndex((x) => x.fileId === e.fileId);
    if (eps[i + 1]) next = { fileId: eps[i + 1].fileId, season: eps[i + 1].season, episode: eps[i + 1].episode, name: eps[i + 1].name };
  }
  send(res, 200, {
    fileId: p.fileId, titleId: t.id, title: view(t).title, type: t.type, saga: !!t.saga,
    season: e?.season ?? null, episode: e?.episode ?? null, episodeName: e?.name ?? null,
    subs: e ? e.subs : t.subs, progress: (D.progress[user.id] || {})[p.fileId] || null, next,
    ...audioInfo(p.fileId),
    ext: (D.files[p.fileId].path.split('.').pop() || '').toLowerCase(),
    backdrop: view(t).backdrop,
  });
});

route('POST', '/api/progress', { auth: true }, async (req, res, p, user) => {
  const { fileId, t, d } = await readBody(req);
  const own = findFileOwner(fileId);
  if (!own) return fail(res, 404, 'No encontrado');
  const prog = (D.progress[user.id] = D.progress[user.id] || {});
  prog[fileId] = { t: Math.max(0, +t || 0), d: Math.max(0, +d || 0), titleId: own.title.id, at: Date.now() };
  db.save();
  send(res, 200, { ok: true });
});

route('POST', '/api/mylist/:id', { auth: true }, (req, res, p, user) => {
  if (!D.titles[p.id]) return fail(res, 404, 'No encontrado');
  const list = (D.mylist[user.id] = D.mylist[user.id] || []);
  const i = list.indexOf(p.id);
  if (i >= 0) list.splice(i, 1); else list.unshift(p.id);
  db.save();
  send(res, 200, { inList: i < 0 });
});

// --- Contenido desde la nube (requiere sesión) ---
async function pipeFile(req, res, fileId, kinds) {
  const f = D.files[fileId];
  if (!f || !kinds.includes(f.kind)) return fail(res, 404, 'No encontrado');
  try {
    const r = await storage.open(f.root, f.path, req.headers.range);
    if (f.kind === 'sub') {
      // Subtítulos: se convierten a WebVTT para el reproductor
      const chunks = []; for await (const c of r.stream) chunks.push(c);
      let text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').replace(/\r/g, '');
      if (!/^WEBVTT/.test(text)) text = 'WEBVTT\n\n' + text.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
      return send(res, 200, text, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
    }
    res.writeHead(r.status, { ...r.headers, 'Cache-Control': f.kind === 'image' ? 'private, max-age=86400' : 'private, no-transform' });
    if (!r.stream) return res.end();
    r.stream.pipe(res);
    req.on('close', () => r.stream.destroy && r.stream.destroy());
  } catch (e) {
    log('Error leyendo de la nube:', e.message);
    if (!res.headersSent) fail(res, 502, 'No se pudo leer el archivo de la nube.');
    else res.destroy();
  }
}
route('GET', '/stream/:fileId', { auth: true }, (req, res, p) => pipeFile(req, res, p.fileId, ['video']));
// Punto real de arranque: el fotograma clave en o antes de t (el vídeo solo puede empezar ahí)
route('GET', '/api/seek/:fileId', { auth: true }, (req, res, p) => {
  const f = D.files[p.fileId];
  if (!f || f.kind !== 'video') return fail(res, 404, 'No encontrado');
  const t = Math.max(0, parseFloat(new URL(req.url, 'http://x').searchParams.get('t')) || 0);
  if (t < 0.5) return send(res, 200, { start: 0 });
  execFileProbe(['-v', 'error', '-rw_timeout', '20000000', '-select_streams', 'v:0', '-read_intervals', `${t}%+#1`,
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', storage.probeUrl(f.root, f.path)], (err, out) => {
    const k = parseFloat(String(out || '').trim().split('\n')[0]);
    send(res, 200, { start: !err && isFinite(k) && k >= 0 && k <= t + 0.5 ? k : t });
  });
});
function execFileProbe(args, cb) {
  require('child_process').execFile('ffprobe', args, { timeout: 20000, maxBuffer: 1 << 20 }, cb);
}

// ---------- Compatibilidad: argumentos de ffmpeg ----------
// Vídeo: se copia tal cual (sin coste) o se convierte a H.264 8 bits (lo reproduce cualquier aparato).
function videoArgs(vmode, m) {
  if (vmode === 'h264') {
    return ['-c:v', 'libx264', '-preset', process.env.TRANSCODE_PRESET || 'veryfast', '-crf', '21',
      '-maxrate', '10M', '-bufsize', '20M', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
      '-vf', "scale='min(1920,iw)':-2", '-g', '48', '-sc_threshold', '0'];
  }
  const hevc = m && m.video && m.video.codec === 'hevc';
  return ['-c:v', 'copy', ...(hevc ? ['-tag:v', 'hvc1'] : [])];
}
// Audio: siempre AAC estéreo (compatible con todo)
const audioArgs = ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];
let transcodes = 0; // conversiones de imagen en marcha (usan CPU)
const MAX_TRANSCODES = parseInt(process.env.MAX_TRANSCODES || '2', 10);

// Vídeo con otra pista de audio, preparado al vuelo con ffmpeg (el archivo original no se toca).
// /stream/ID/audio/N?t=SEGUNDOS  -> MP4 fragmentado que empieza en ese segundo
const remuxing = new Map(); // userId -> proceso ffmpeg (uno por usuario)
route('GET', '/stream/:fileId/audio/:n', { auth: true }, (req, res, p, user) => {
  const f = D.files[p.fileId];
  const n = parseInt(p.n, 10);
  const m = (D.media || {})[p.fileId];
  const audioCount = m ? (m.audio || []).length : 0;
  if (!f || f.kind !== 'video' || !(n >= 0 && (n < audioCount || n === 0))) return fail(res, 404, 'No encontrado');
  const q = new URL(req.url, 'http://x').searchParams;
  const t = Math.max(0, parseFloat(q.get('t')) || 0);
  const vmode = q.get('v') === 'h264' ? 'h264' : 'copy';
  if (vmode === 'h264' && transcodes >= MAX_TRANSCODES) return fail(res, 503, 'El servidor está convirtiendo demasiados vídeos a la vez. Inténtalo en un momento.');
  const prev = remuxing.get(user.id); if (prev) prev.kill('SIGKILL');
  // Desde el principio se conservan los tiempos originales con una "edit list" (si no, la imagen
  // de HEVC/H.264 con fotogramas B sale unas décimas tarde respecto al audio).
  // Desde otro punto, t es un fotograma clave (lo calcula /api/seek) y las pistas salen alineadas.
  const fromStart = t < 0.05;
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '30000000',
    ...(fromStart ? [] : ['-ss', String(t)]), '-i', storage.probeUrl(f.root, f.path),
    '-map', '0:v:0', '-map', `0:a:${n}?`, '-sn', '-dn',
    ...videoArgs(vmode, m), ...audioArgs,
    ...(fromStart ? ['-movflags', 'frag_keyframe+delay_moov+default_base_moof', '-use_editlist', '1']
                  : ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']),
    '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  remuxing.set(user.id, ff);
  if (vmode === 'h264') { transcodes++; ff.once('close', () => { transcodes--; }); }
  let err = '';
  ff.stderr.on('data', (d) => { err = (err + d).slice(-500); });
  res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
  ff.stdout.pipe(res);
  const stop = () => { try { ff.kill('SIGKILL'); } catch {} };
  req.on('close', stop);
  ff.on('close', (code) => { if (remuxing.get(user.id) === ff) remuxing.delete(user.id); if (code && err) log('ffmpeg:', err.trim()); res.end(); });
  ff.on('error', (e) => { log('ffmpeg no disponible:', e.message); res.end(); });
});

// ---------- HLS para iPhone/iPad ----------
// Safari no reproduce MKV/AVI ni vídeo preparado al vuelo sin rangos: se genera HLS (formato nativo de Apple).
// /hls/ID/index.m3u8?inicio=1  -> el servidor elige castellano, reanuda donde ibas y decide si convierte la imagen.
const os = require('os');
const HLS_DIR = path.join(os.tmpdir(), 'nubecine-hls');
fs.mkdirSync(HLS_DIR, { recursive: true });
const hlsSessions = new Map(); // sid -> {userId, fileId, dir, ff, start, n, last, vmode}
function stopHls(sid) {
  const h = hlsSessions.get(sid); if (!h) return;
  try { h.ff.kill('SIGKILL'); } catch {}
  if (h.vmode === 'h264' && !h.ended) transcodes = Math.max(0, transcodes - 1);
  fs.rm(h.dir, { recursive: true, force: true }, () => {});
  hlsSessions.delete(sid);
}
setInterval(() => { for (const [sid, h] of hlsSessions) if (Date.now() - h.last > 20 * 60 * 1000) stopHls(sid); }, 60000).unref();
function iosVideoOk(m) {
  const v = m && m.video; if (!v) return false;
  if (v.codec === 'h264') return !/10|12|422|444/.test(v.pixFmt) && !/high 10|high 4:2:2|high 4:4:4/i.test(v.profile);
  return v.codec === 'hevc';
}
function probeKeyframe(f, t) {
  return new Promise((resolve) => {
    if (t < 0.5) return resolve(0);
    execFileProbe(['-v', 'error', '-rw_timeout', '20000000', '-select_streams', 'v:0', '-read_intervals', `${t}%+#1`,
      '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', storage.probeUrl(f.root, f.path)], (err, out) => {
      const k = parseFloat(String(out || '').trim().split('\n')[0]);
      resolve(!err && isFinite(k) && k >= 0 && k <= t + 0.5 ? k : t);
    });
  });
}
route('GET', '/hls/:fileId/index.m3u8', { auth: true }, async (req, res, p, user) => {
  const f = D.files[p.fileId];
  if (!f || f.kind !== 'video') return fail(res, 404, 'No encontrado');
  const m = (D.media || {})[p.fileId] || null;
  const q = new URL(req.url, 'http://x').searchParams;
  // Sesión: una por usuario y vídeo (el reproductor vuelve a pedir la lista cada pocos segundos)
  let sid = [...hlsSessions.keys()].find((k) => { const h = hlsSessions.get(k); return h.userId === user.id && h.fileId === p.fileId && !q.get('nueva'); });
  if (!sid) {
    for (const [k, h] of hlsSessions) if (h.userId === user.id) stopHls(k); // solo un vídeo por usuario
    const prog = (D.progress[user.id] || {})[p.fileId];
    const want = q.get('inicio') ? 0 : (prog && prog.t > 15 && prog.d && prog.t / prog.d < 0.93 ? prog.t - 3 : 0);
    const start = await probeKeyframe(f, want);
    const n = m && m.pref != null ? m.pref : 0;
    let vmode = iosVideoOk(m) ? 'copy' : 'h264';
    if (vmode === 'h264' && transcodes >= MAX_TRANSCODES) return fail(res, 503, 'El servidor está convirtiendo demasiados vídeos a la vez.');
    sid = crypto.randomBytes(8).toString('hex');
    const dir = path.join(HLS_DIR, sid);
    fs.mkdirSync(dir, { recursive: true });
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '30000000',
      ...(start > 0 ? ['-ss', String(start)] : []), ...(vmode === 'copy' ? ['-readrate', '4'] : []),
      '-i', storage.probeUrl(f.root, f.path),
      '-map', '0:v:0', '-map', `0:a:${n}?`, '-sn', '-dn', ...videoArgs(vmode, m), ...audioArgs,
      '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(dir, 'seg%05d.m4s'),
      path.join(dir, 'index.m3u8')], { stdio: ['ignore', 'ignore', 'pipe'] });
    const h = { userId: user.id, fileId: p.fileId, dir, ff, start, n, last: Date.now(), vmode, ended: false };
    if (vmode === 'h264') transcodes++;
    let err = '';
    ff.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    ff.on('close', (code) => { if (vmode === 'h264' && !h.ended) { h.ended = true; transcodes = Math.max(0, transcodes - 1); } if (code && err) log('ffmpeg HLS:', err.trim()); });
    hlsSessions.set(sid, h);
  }
  const h = hlsSessions.get(sid);
  h.last = Date.now();
  // Espera a que exista la lista con al menos un fragmento (máx. 25 s)
  const list = path.join(h.dir, 'index.m3u8');
  for (let i = 0; i < 100 && !(fs.existsSync(list) && /\.m4s/.test(fs.readFileSync(list, 'utf8'))); i++) await new Promise((r) => setTimeout(r, 250));
  if (!fs.existsSync(list)) return fail(res, 504, 'No se pudo preparar el vídeo');
  const body = fs.readFileSync(list, 'utf8').replace(/^(init\.mp4|seg\d+\.m4s)$/gm, `/hls/s/${sid}/$1`).replace(/URI="init\.mp4"/, `URI="/hls/s/${sid}/init.mp4"`);
  send(res, 200, body, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'X-Start': String(h.start) });
});
route('GET', '/hls/s/:sid/:file', { auth: true }, (req, res, p, user) => {
  const h = hlsSessions.get(p.sid);
  if (!h || h.userId !== user.id || !/^(init\.mp4|seg\d+\.m4s)$/.test(p.file)) return fail(res, 404, 'No encontrado');
  h.last = Date.now();
  const file = path.join(h.dir, p.file);
  if (!fs.existsSync(file)) return fail(res, 404, 'Aún no disponible');
  res.writeHead(200, { 'Content-Type': p.file.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'private, max-age=3600' });
  fs.createReadStream(file).pipe(res);
});
// Desde qué segundo empieza la sesión HLS (para guardar bien el progreso)
route('GET', '/api/hls-info/:fileId', { auth: true }, (req, res, p, user) => {
  const h = [...hlsSessions.values()].find((x) => x.userId === user.id && x.fileId === p.fileId);
  send(res, 200, { start: h ? h.start : 0, active: !!h });
});

route('GET', '/img/:fileId', { auth: true }, (req, res, p) => pipeFile(req, res, p.fileId, ['image']));
route('GET', '/sub/:fileId', { auth: true }, (req, res, p) => pipeFile(req, res, p.fileId, ['sub']));

// --- Administración ---
route('POST', '/api/admin/scan', { admin: true }, async (req, res) => {
  try { send(res, 200, await scan()); } catch (e) { fail(res, 502, 'Error al leer la nube: ' + e.message); }
});
route('GET', '/api/admin/titles', { admin: true }, (req, res) => {
  send(res, 200, Object.values(D.titles).map((t) => ({ ...view(t), folder: t.folder, hidden: !!(t.edited && t.edited.hidden), edited: t.edited || {} }))
    .sort((a, b) => a.title.localeCompare(b.title, 'es')));
});
route('PUT', '/api/admin/title/:id', { admin: true }, async (req, res, p) => {
  const t = D.titles[p.id];
  if (!t) return fail(res, 404, 'No encontrado');
  const body = await readBody(req);
  t.edited = t.edited || {};
  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === '') delete t.edited[k];
    else if (k === 'year' || k === 'rating') t.edited[k] = Number(v) || null;
    else if (k === 'genres') t.edited[k] = Array.isArray(v) ? v.map(String) : String(v).split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === 'hidden') { if (v) t.edited.hidden = true; else delete t.edited.hidden; }
    else if ((k === 'posterUrl' || k === 'backdropUrl') && !/^https:\/\//.test(v)) return fail(res, 400, 'Las imágenes deben ser enlaces https://');
    else t.edited[k] = String(v).slice(0, 4000);
  }
  db.save();
  catalogChanged();
  send(res, 200, view(t));
});
route('GET', '/api/admin/users', { admin: true }, (req, res) => {
  send(res, 200, D.users.map((u) => ({ ...publicUser(u), createdAt: u.createdAt, approved: u.approved !== false, lastLogin: u.lastLogin || null,
    devices: Object.values(D.sessions).filter((s) => s.userId === u.id).length })));
});
route('GET', '/api/admin/access-log', { admin: true }, (req, res) => {
  send(res, 200, (D.accessLog || []).slice(0, 150).map((a) => ({ ...a, place: isPrivate(a.ip) ? 'red local' : geo.info.loaded ? (geo.allowed(a.ip) ? 'España' : 'fuera de España') : '' })));
});
route('POST', '/api/admin/users/:id', { admin: true }, async (req, res, p, me) => {
  const u = D.users.find((x) => x.id === p.id);
  if (!u) return fail(res, 404, 'No encontrado');
  const { admin, password, approved, logout } = await readBody(req);
  if (typeof approved === 'boolean') u.approved = approved;
  if (logout || approved === false) for (const [k, s] of Object.entries(D.sessions)) if (s.userId === u.id) delete D.sessions[k];
  if (typeof admin === 'boolean' && ADMIN_USER) return fail(res, 400, 'El administrador está fijado en la configuración del servidor.');
  if (typeof admin === 'boolean') {
    if (u.id === me.id && !admin) return fail(res, 400, 'No puedes quitarte el rol de administrador a ti mismo.');
    u.admin = admin;
  }
  if (password) {
    const problem = passwordProblem(password, u.username); if (problem) return fail(res, 400, problem);
    u.salt = crypto.randomBytes(16).toString('hex'); u.passHash = hashPass(String(password), u.salt);
    for (const [k, s] of Object.entries(D.sessions)) if (s.userId === u.id) delete D.sessions[k];
  }
  db.save();
  send(res, 200, publicUser(u));
});
route('DELETE', '/api/admin/users/:id', { admin: true }, (req, res, p, me) => {
  if (p.id === me.id) return fail(res, 400, 'No puedes borrar tu propia cuenta.');
  D.users = D.users.filter((u) => u.id !== p.id);
  for (const [k, s] of Object.entries(D.sessions)) if (s.userId === p.id) delete D.sessions[k];
  delete D.progress[p.id]; delete D.mylist[p.id];
  db.save();
  send(res, 200, { ok: true });
});
route('GET', '/api/admin/settings', { admin: true }, (req, res) => {
  const myIp = clientIp(req);
  const myIpStatus = isPrivate(myIp) ? 'red local' : !geo.info.loaded ? 'sin comprobar' : geo.allowed(myIp) ? 'España' : 'fuera de España';
  send(res, 200, { security: { countries: GEO_COUNTRIES, geo: geo.info, ...guard.stats, bannedNow: guard.bans.size, myIp, myIpStatus }, adminFixed: !!ADMIN_USER, inviteCode: D.settings.inviteCode, requireInvite: !!D.settings.requireInvite, requireApproval: D.settings.requireApproval === true, allowedUsers: D.settings.allowedUsers || [], allowedFromEnv: process.env.ALLOWED_USERS !== undefined, pending: D.users.filter((u) => u.approved === false).length, siteName: D.settings.siteName || cfg.siteName, storage: cfg.storage, remote: cfg.remote, libraryPath: cfg.libraryPath, sections: D.sections || [], moviesPath: cfg.moviesPath, seriesPath: cfg.seriesPath, tmdb: !!cfg.tmdbApiKey, lastScan: D.lastScan });
});
route('PUT', '/api/admin/settings', { admin: true }, async (req, res) => {
  const { inviteCode, siteName, requireInvite, requireApproval, allowedUsers } = await readBody(req);
  if (allowedUsers !== undefined) {
    const list = (Array.isArray(allowedUsers) ? allowedUsers : String(allowedUsers).split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
    if (ADMIN_USER && list.length && !list.some((x) => x.toLowerCase() === ADMIN_USER)) list.unshift(D.users.find((u) => u.username.toLowerCase() === ADMIN_USER)?.username || ADMIN_USER);
    D.settings.allowedUsers = list;
  }
  if (requireInvite !== undefined) D.settings.requireInvite = !!requireInvite;
  if (requireApproval !== undefined) D.settings.requireApproval = !!requireApproval;
  if (inviteCode !== undefined) { if (String(inviteCode).trim().length < 4) return fail(res, 400, 'El código debe tener al menos 4 caracteres.'); D.settings.inviteCode = String(inviteCode).trim(); }
  if (siteName !== undefined) D.settings.siteName = String(siteName).trim().slice(0, 40) || undefined;
  db.save();
  send(res, 200, { ok: true });
});

// ---------- Archivos estáticos ----------
const PUBLIC = path.join(ROOT, 'public');
const STATIC_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'Prohibido');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------- Servidor ----------
// ---------- Seguridad de acceso ----------
const GEO_COUNTRIES = (process.env.GEO_COUNTRIES ?? cfg.geoCountries ?? 'ES').toUpperCase().split(/[,\s]+/).filter((c) => /^[A-Z]{2}$/.test(c));
const geo = new GeoDB(path.join(path.dirname(path.resolve(ROOT, cfg.dataFile)), 'geo'), GEO_COUNTRIES, log);
const guard = new Guard();
const SCANNER = /\.(php|asp|aspx|jsp|cgi|env|git|sql|bak|ini)(\/|$|\?)|\/wp-|\/wordpress|phpmyadmin|\/\.well-known\/(?!acme)|\/(admin|login)\.|\/cgi-bin|\/vendor\/|\/\.(git|env|aws|ssh)/i;
const ATTACK_UA = /sqlmap|nikto|nmap|masscan|zgrab|nuclei|wpscan|dirbuster|gobuster|feroxbuster|ffuf|acunetix|nessus|openvas|hydra|jaeles|whatweb|commix|xsstrike/i;
function blockedPage(res, status, title, msg) {
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0c10;color:#eef1f6;font-family:system-ui,sans-serif;text-align:center;padding:24px}h1{font-size:24px;margin:0 0 10px}p{color:#9097a6;margin:0}</style></head>
<body><div><h1>${title}</h1><p>${msg}</p></div></body></html>`);
}
// Devuelve true si la petición se ha bloqueado
function security(req, res, url) {
  const ip = clientIp(req);
  if (guard.banned(ip)) { res.writeHead(403, SEC_HEADERS); res.end(); return true; }
  // Rastreadores buscando fallos (wp-login.php, .env, .git…): 5 intentos = 1 hora bloqueado
  if (SCANNER.test(url.pathname)) {
    if (guard.count('scan:' + ip, 5, 10 * 60 * 1000)) { guard.ban(ip, 3600 * 1000); log('IP bloqueada por rastreo:', ip); }
    res.writeHead(404, SEC_HEADERS); res.end(); return true;
  }
  // Herramientas de ataque conocidas (por su identificación): bloqueo inmediato de 1 día
  if (ATTACK_UA.test(req.headers['user-agent'] || '')) {
    guard.ban(ip, 24 * 3600 * 1000); log('IP bloqueada (herramienta de ataque):', ip);
    res.writeHead(403, SEC_HEADERS); res.end(); return true;
  }
  // Solo desde los países permitidos (España). Las IPs de la red local siempre pueden entrar.
  // Por el túnel de Cloudflare se usa el país que da Cloudflare (y se bloquea la red Tor, "T1").
  const cc = cfCountry(req);
  const geoBlocked = GEO_COUNTRIES.length && !isPrivate(ip) && (cc ? !GEO_COUNTRIES.includes(cc) : (geo.info.loaded && !geo.allowed(ip)));
  if (geoBlocked) {
    guard.stats.geoBlocked++;
    const name = D.settings.siteName || cfg.siteName;
    if (url.pathname.startsWith('/api/')) fail(res, 403, `${name} solo está disponible en España.`);
    else blockedPage(res, 403, `${name} solo está disponible en España`, 'Este servicio no está disponible en tu país.');
    return true;
  }
  // Límite de peticiones: API 300/min, total 4000/min por IP (los vídeos hacen muchas)
  const isApi = url.pathname.startsWith('/api/') && url.pathname !== '/api/events';
  if ((isApi && guard.count('api:' + ip, 300, 60000)) || guard.count('all:' + ip, 4000, 60000)) {
    guard.stats.rateLimited++;
    res.writeHead(429, { ...SEC_HEADERS, 'Retry-After': '30', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Demasiadas peticiones. Espera unos segundos.' }));
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (security(req, res, url)) return;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin || req.headers.referer;
    if (origin) { let h = ''; try { h = new URL(origin).host; } catch {} if (h !== req.headers.host) return fail(res, 403, 'Petición no permitida.'); }
  }
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let user = null;
      if (r.auth || r.admin) {
        user = currentUser(req);
        if (!user) return fail(res, 401, 'Inicia sesión');
        if (r.admin && !user.admin) return fail(res, 403, 'Solo administradores');
      }
      return await r.handler(req, res, params, user);
    }
    if (url.pathname.startsWith('/api/')) return fail(res, 404, 'No existe');
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    fail(res, 405, 'Método no permitido');
  } catch (e) {
    log('Error:', e.stack || e.message);
    if (!res.headersSent) fail(res, 500, 'Error interno');
  }
});

if (require.main === module) {
  server.listen(cfg.port, () => {
    log(`${cfg.siteName} escuchando en http://localhost:${cfg.port}`);
    log(`Almacenamiento: ${cfg.storage === 'local' ? 'carpeta ' + cfg.localPath : 'rclone ' + cfg.remote + ' vía ' + cfg.rcloneUrl}`);
    log(`Código de invitación actual: ${D.settings.inviteCode}`);
    // Base de datos de países (se actualiza cada mes)
    if (GEO_COUNTRIES.length) {
      geo.loadCache();
      log(geo.info.loaded ? `Acceso solo desde: ${GEO_COUNTRIES.join(', ')} (${geo.info.ranges} rangos)` : 'Preparando la restricción por país…');
      const upd = () => geo.update().catch((e) => log('Base de países:', e.message));
      upd(); setInterval(upd, 24 * 3600 * 1000).unref();
    } else log('Restricción por país desactivada (GEO_COUNTRIES vacío)');
    // Primer escaneo (reintenta mientras rclone arranca)
    const first = (n = 0) => scan().catch((e) => { log('Escaneo inicial falló:', e.message); if (n < 10) setTimeout(() => first(n + 1), 15000); });
    setTimeout(first, 1500);
    // Vigila la nube cada pocos segundos (AUTO_SCAN_SECONDS, 10 por defecto) y solo rehace el catálogo si algo cambió
    const every = Number(process.env.AUTO_SCAN_SECONDS) || (Number(process.env.AUTO_SCAN_MINUTES) === 0 ? 0 : 10);
    if (every > 0) {
      let errs = 0;
      setInterval(() => scan(false).then(() => { errs = 0; }).catch((e) => { if (errs++ % 30 === 0) log('Escaneo falló:', e.message); }), Math.max(5, every) * 1000);
      log(`Contenido nuevo: se detecta en unos ${Math.max(5, every)} segundos`);
    }
  });
  const bye = () => { db.flush(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

module.exports = { server, scan, db, cfg };
