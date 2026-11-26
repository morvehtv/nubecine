'use strict';
// Seguridad de acceso:
//  - Bloqueo por país (solo España por defecto) con la base de datos gratuita DB-IP Lite.
//  - Límite de peticiones por IP y bloqueo temporal de IPs que rastrean la web.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const net = require('net');

// ---------- IPs ----------
function ipToBig(ip) {
  if (net.isIPv4(ip)) return BigInt(ip.split('.').reduce((n, o) => n * 256 + parseInt(o, 10), 0));
  if (!net.isIPv6(ip)) return null;
  // Expande "::" y convierte a número de 128 bits
  let [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  // IPv4 incrustada al final (::ffff:1.2.3.4)
  const last = (t.length ? t : h)[(t.length ? t : h).length - 1] || '';
  if (last.includes('.')) {
    const v4 = last.split('.').map((x) => parseInt(x, 10));
    const arr = t.length ? t : h;
    arr.splice(arr.length - 1, 1, ((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
  }
  const fill = ip.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  const parts = [...h, ...fill, ...t];
  return parts.reduce((n, p) => (n << 16n) + BigInt(parseInt(p || '0', 16)), 0n);
}
function normalizeIp(ip) {
  ip = String(ip || '').trim();
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) return ip.slice(7);
  return ip;
}
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}

// ---------- Base de datos de países ----------
class GeoDB {
  constructor(dir, countries, log) {
    this.dir = dir; this.countries = countries; this.log = log;
    this.v4 = []; this.v6 = []; // [[inicio, fin], …] ordenados (solo países permitidos)
    this.info = { loaded: false, updated: null, ranges: 0, source: 'DB-IP Lite (db-ip.com)' };
    fs.mkdirSync(dir, { recursive: true });
  }
  cacheFile() { return path.join(this.dir, `rangos-${this.countries.join('-')}.json`); }
  loadCache() {
    try {
      const j = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8'));
      this.v4 = j.v4.map(([a, b]) => [BigInt(a), BigInt(b)]);
      this.v6 = j.v6.map(([a, b]) => [BigInt(a), BigInt(b)]);
      this.info = { ...this.info, loaded: true, updated: j.updated, ranges: this.v4.length + this.v6.length };
      return j;
    } catch { return null; }
  }
  // Convierte el CSV (inicio,fin,país) en rangos de los países permitidos
  importCsv(csvText) {
    const v4 = [], v6 = [];
    for (const line of csvText.split('\n')) {
      const [a, b, c] = line.trim().split(',');
      if (!c || !this.countries.includes(c.toUpperCase())) continue;
      const s = ipToBig(a), e = ipToBig(b);
      if (s == null || e == null) continue;
      (net.isIPv4(a) ? v4 : v6).push([s, e]);
    }
    v4.sort((x, y) => (x[0] < y[0] ? -1 : 1)); v6.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    if (v4.length < 10) throw new Error('La base de datos de países parece vacía');
    const updated = new Date().toISOString();
    fs.writeFileSync(this.cacheFile(), JSON.stringify({ updated, v4: v4.map(([s, e]) => [String(s), String(e)]), v6: v6.map(([s, e]) => [String(s), String(e)]) }));
    this.v4 = v4; this.v6 = v6;
    this.info = { ...this.info, loaded: true, updated, ranges: v4.length + v6.length };
  }
  download(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'NubeCine' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const chunks = [];
        res.pipe(zlib.createGunzip()).on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))).on('error', reject);
      }).on('error', reject).setTimeout(120000, function () { this.destroy(new Error('Tiempo agotado')); });
    });
  }
  // Descarga la base del mes (o la del mes anterior) si la guardada tiene más de 30 días
  async update(force = false) {
    const cached = this.loadCache();
    if (!force && cached && Date.now() - new Date(cached.updated).getTime() < 30 * 864e5) return;
    const d = new Date();
    const months = [0, 1].map((back) => { const x = new Date(d.getFullYear(), d.getMonth() - back, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; });
    for (const m of months) {
      try {
        this.log(`Descargando base de datos de países (${m})…`);
        this.importCsv(await this.download(`https://download.db-ip.com/free/dbip-country-lite-${m}.csv.gz`));
        this.log(`Países: ${this.info.ranges} rangos de IP permitidos (${this.countries.join(', ')})`);
        return;
      } catch (e) { this.log(`No se pudo descargar la base de países ${m}: ${e.message}`); }
    }
  }
  allowed(ip) {
    const n = ipToBig(ip); if (n == null) return false;
    const list = net.isIPv4(ip) ? this.v4 : this.v6;
    let lo = 0, hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (n < list[mid][0]) hi = mid - 1; else if (n > list[mid][1]) lo = mid + 1; else return true;
    }
    return false;
  }
}

// ---------- Límite de peticiones y bloqueos ----------
class Guard {
  constructor() { this.hits = new Map(); this.bans = new Map(); this.stats = { geoBlocked: 0, rateLimited: 0, banned: 0 }; setInterval(() => this.clean(), 60000).unref(); }
  clean() { const now = Date.now(); for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k); for (const [k, until] of this.bans) if (until < now) this.bans.delete(k); }
  // Cuenta un evento; devuelve true si supera el máximo en la ventana
  count(key, max, windowMs) {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; this.hits.set(key, h); }
    return ++h.n > max;
  }
  ban(ip, ms) { this.bans.set(ip, Date.now() + ms); this.stats.banned++; }
  banned(ip) { const u = this.bans.get(ip); return u && u > Date.now(); }
}

module.exports = { GeoDB, Guard, normalizeIp, isPrivate, ipToBig };
