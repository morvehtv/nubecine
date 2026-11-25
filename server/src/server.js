'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DB = require('./db');
const { createStorage } = require('./storage');
const { buildLibrary, mergeCatalog, enrichWithTMDB, EDITABLE } = require('./scanner');

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
  autoScanMinutes: 5,
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
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
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

// ---------- Usuarios y sesiones ----------
const hashPass = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function newSession(res, req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  D.sessions[token] = { userId: user.id, expires: Date.now() + 1000 * 60 * 60 * 24 * 60 };
  db.save();
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 60}; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}
function currentUser(req) {
  const token = cookies(req).sid || (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = token && D.sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) { delete D.sessions[token]; db.save(); return null; }
  return D.users.find((u) => u.id === s.userId) || null;
}
const publicUser = (u) => ({ id: u.id, username: u.username, admin: !!u.admin });

const attempts = new Map(); // ip -> {n, until}
function tooMany(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return true;
  a.n++; if (a.n >= 8) { a.until = Date.now() + 10 * 60 * 1000; a.n = 0; }
  attempts.set(ip, a);
  return false;
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

let scanning = null;
async function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    const t0 = Date.now();
    const all = await storage.list(cfg.libraryPath);
    const fresh = buildLibrary(all, cfg.libraryPath);
    D.titles = mergeCatalog(D.titles, fresh.titles);
    D.files = fresh.files;
    D.sections = fresh.sections;
    const enriched = await enrichWithTMDB(D.titles, cfg.tmdbApiKey, log);
    D.lastScan = { at: new Date().toISOString(), ms: Date.now() - t0, files: all.length, sections: fresh.sections.length, titles: Object.keys(D.titles).length, enriched };
    db.save();
    log('Escaneo completado:', JSON.stringify(D.lastScan));
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

route('GET', '/api/config', (req, res) => send(res, 200, { siteName: D.settings.siteName || cfg.siteName, requireInvite: !!D.settings.requireInvite }));

route('POST', '/api/register', async (req, res) => {
  if (tooMany(req)) return fail(res, 429, 'Demasiados intentos. Espera unos minutos.');
  const { username, password, inviteCode } = await readBody(req);
  const name = String(username || '').trim();
  if (!/^[\w.\-áéíóúñÁÉÍÓÚÑ]{3,30}$/.test(name)) return fail(res, 400, 'El usuario debe tener entre 3 y 30 letras o números.');
  if (String(password || '').length < 6) return fail(res, 400, 'La contraseña debe tener al menos 6 caracteres.');
  if (D.settings.requireInvite && String(inviteCode || '').trim() !== D.settings.inviteCode) return fail(res, 403, 'El código de invitación no es correcto.');
  if (D.users.some((u) => u.username.toLowerCase() === name.toLowerCase())) return fail(res, 409, 'Ese usuario ya existe.');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: crypto.randomUUID(), username: name, salt, passHash: hashPass(password, salt), admin: ADMIN_USER ? name.toLowerCase() === ADMIN_USER : D.users.length === 0, createdAt: new Date().toISOString() };
  D.users.push(user); db.save();
  newSession(res, req, user);
  send(res, 200, publicUser(user));
});

route('POST', '/api/login', async (req, res) => {
  if (tooMany(req)) return fail(res, 429, 'Demasiados intentos. Espera unos minutos.');
  const { username, password } = await readBody(req);
  const u = D.users.find((x) => x.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!u || !crypto.timingSafeEqual(Buffer.from(hashPass(String(password || ''), u.salt), 'hex'), Buffer.from(u.passHash, 'hex'))) {
    return fail(res, 401, 'Usuario o contraseña incorrectos.');
  }
  newSession(res, req, u);
  send(res, 200, publicUser(u));
});

route('POST', '/api/logout', (req, res) => {
  const token = cookies(req).sid; if (token) { delete D.sessions[token]; db.save(); }
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  send(res, 200, { ok: true });
});

route('GET', '/api/me', { auth: true }, (req, res, p, user) => send(res, 200, publicUser(user)));

route('POST', '/api/password', { auth: true }, async (req, res, p, user) => {
  const { current, next } = await readBody(req);
  if (hashPass(String(current || ''), user.salt) !== user.passHash) return fail(res, 401, 'La contraseña actual no es correcta.');
  if (String(next || '').length < 6) return fail(res, 400, 'La nueva contraseña debe tener al menos 6 caracteres.');
  user.salt = crypto.randomBytes(16).toString('hex'); user.passHash = hashPass(next, user.salt); db.save();
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
  } else {
    out.seasons = Object.keys(t.seasons).map(Number).sort((a, b) => a - b).map((s) => ({
      season: s,
      episodes: t.seasons[s].map((e) => ({ ...e, progress: prog[e.fileId] || null })),
    }));
  }
  send(res, 200, out);
});

route('GET', '/api/play/:fileId', { auth: true }, (req, res, p, user) => {
  const own = findFileOwner(p.fileId);
  if (!own) return fail(res, 404, 'No encontrado');
  const { title: t, episode: e } = own;
  let next = null;
  if (e) {
    const eps = allEpisodes(t); const i = eps.findIndex((x) => x.fileId === e.fileId);
    if (eps[i + 1]) next = { fileId: eps[i + 1].fileId, season: eps[i + 1].season, episode: eps[i + 1].episode, name: eps[i + 1].name };
  }
  send(res, 200, {
    fileId: p.fileId, titleId: t.id, title: view(t).title, type: t.type,
    season: e?.season ?? null, episode: e?.episode ?? null, episodeName: e?.name ?? null,
    subs: e ? e.subs : t.subs, progress: (D.progress[user.id] || {})[p.fileId] || null, next,
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
  send(res, 200, view(t));
});
route('GET', '/api/admin/users', { admin: true }, (req, res) => {
  send(res, 200, D.users.map((u) => ({ ...publicUser(u), createdAt: u.createdAt })));
});
route('POST', '/api/admin/users/:id', { admin: true }, async (req, res, p, me) => {
  const u = D.users.find((x) => x.id === p.id);
  if (!u) return fail(res, 404, 'No encontrado');
  const { admin, password } = await readBody(req);
  if (typeof admin === 'boolean' && ADMIN_USER) return fail(res, 400, 'El administrador está fijado en la configuración del servidor.');
  if (typeof admin === 'boolean') {
    if (u.id === me.id && !admin) return fail(res, 400, 'No puedes quitarte el rol de administrador a ti mismo.');
    u.admin = admin;
  }
  if (password) {
    if (String(password).length < 6) return fail(res, 400, 'Mínimo 6 caracteres.');
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
  send(res, 200, { adminFixed: !!ADMIN_USER, inviteCode: D.settings.inviteCode, requireInvite: !!D.settings.requireInvite, siteName: D.settings.siteName || cfg.siteName, storage: cfg.storage, remote: cfg.remote, libraryPath: cfg.libraryPath, sections: D.sections || [], moviesPath: cfg.moviesPath, seriesPath: cfg.seriesPath, tmdb: !!cfg.tmdbApiKey, lastScan: D.lastScan });
});
route('PUT', '/api/admin/settings', { admin: true }, async (req, res) => {
  const { inviteCode, siteName, requireInvite } = await readBody(req);
  if (requireInvite !== undefined) D.settings.requireInvite = !!requireInvite;
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
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
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
    // Primer escaneo (reintenta mientras rclone arranca)
    const first = (n = 0) => scan().catch((e) => { log('Escaneo inicial falló:', e.message); if (n < 10) setTimeout(() => first(n + 1), 15000); });
    setTimeout(first, 1500);
    if (cfg.autoScanMinutes > 0) setInterval(() => scan().catch((e) => log('Escaneo falló:', e.message)), cfg.autoScanMinutes * 60000);
  });
  const bye = () => { db.flush(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

module.exports = { server, scan, db, cfg };
