'use strict';
// Acceso a la nube. Dos modos:
//  - "rclone": habla con `rclone rcd --rc-serve` (Jottacloud u otra nube que soporte rclone)
//  - "local":  una carpeta del disco (útil para pruebas o si montas la nube con `rclone mount`)
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm',
  mkv: 'video/webm', // los navegadores Chromium reproducen Matroska anunciado como webm
  ts: 'video/mp2t', avi: 'video/x-msvideo',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  srt: 'text/plain; charset=utf-8', vtt: 'text/vtt; charset=utf-8',
};
const mimeOf = (p) => MIME[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream';

function parseRange(range, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

class LocalStorage {
  constructor(base) { this.base = path.resolve(base); }
  abs(root, rel) {
    const p = path.resolve(this.base, root, rel || '');
    if (!p.startsWith(this.base)) throw new Error('Ruta fuera de la carpeta');
    return p;
  }
  async list(root) {
    const out = [];
    const start = this.abs(root, '');
    if (!fs.existsSync(start)) return out;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          const st = fs.statSync(full);
          out.push({ path: path.relative(start, full).split(path.sep).join('/'), size: st.size, mtime: st.mtime.toISOString() });
        }
      }
    };
    walk(start);
    return out;
  }
  probeUrl(root, rel) { return this.abs(root, rel); }
  async open(root, rel, range) {
    const file = this.abs(root, rel);
    const size = fs.statSync(file).size;
    const headers = { 'Content-Type': mimeOf(rel), 'Accept-Ranges': 'bytes' };
    const r = parseRange(range, size);
    if (r === 'invalid') return { status: 416, headers: { 'Content-Range': `bytes */${size}` }, stream: null };
    if (r) {
      headers['Content-Range'] = `bytes ${r.start}-${r.end}/${size}`;
      headers['Content-Length'] = r.end - r.start + 1;
      return { status: 206, headers, stream: fs.createReadStream(file, r) };
    }
    headers['Content-Length'] = size;
    return { status: 200, headers, stream: fs.createReadStream(file) };
  }
}

class RcloneStorage {
  // rcUrl: p.ej. http://127.0.0.1:5572   remote: p.ej. "jotta:"
  constructor({ rcUrl, remote, rcUser, rcPass }) {
    this.rc = new URL(rcUrl);
    this.remote = remote.endsWith(':') || remote.endsWith('/') ? remote : remote + '/';
    this.auth = rcUser ? 'Basic ' + Buffer.from(`${rcUser}:${rcPass || ''}`).toString('base64') : null;
    this.lib = this.rc.protocol === 'https:' ? https : http;
  }
  fsFor(root) { return this.remote + root.replace(/^\/+|\/+$/g, ''); }
  request(method, pathname, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const h = { ...headers };
      if (this.auth) h.Authorization = this.auth;
      const req = this.lib.request({
        hostname: this.rc.hostname, port: this.rc.port, method, path: pathname, headers: h,
      }, resolve);
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('Tiempo de espera agotado con rclone')));
      if (body) req.write(body);
      req.end();
    });
  }
  async list(root) {
    const body = JSON.stringify({ fs: this.fsFor(root), remote: '', opt: { recurse: true, filesOnly: true, noMimeType: true } });
    const res = await this.request('POST', '/operations/list', { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (res.statusCode !== 200) {
      // Si la carpeta aún no existe en la nube, devolvemos lista vacía
      if (/directory not found|not found/i.test(text)) return [];
      throw new Error(`rclone respondió ${res.statusCode}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    return (json.list || []).filter((x) => !x.IsDir).map((x) => ({ path: x.Path, size: x.Size, mtime: x.ModTime }));
  }
  objectPath(root, rel) {
    const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
    const fsName = this.fsFor(root).split('/').map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':')).join('/');
    return `/[${fsName}]/${enc(rel)}`;
  }
  probeUrl(root, rel) {
    const u = new URL(this.rc.href);
    if (this.auth) { const [user, pass] = Buffer.from(this.auth.slice(6), 'base64').toString().split(':'); u.username = user; u.password = pass; }
    return u.origin.replace('://', '://' + (u.username ? `${u.username}:${u.password}@` : '')) + this.objectPath(root, rel);
  }
  async open(root, rel, range) {
    const url = this.objectPath(root, rel);
    const res = await this.request('GET', url, range ? { Range: range } : {});
    const headers = { 'Content-Type': mimeOf(rel), 'Accept-Ranges': 'bytes' };
    for (const k of ['content-length', 'content-range', 'last-modified', 'etag']) {
      if (res.headers[k]) headers[k.replace(/(^|-)\w/g, (s) => s.toUpperCase())] = res.headers[k];
    }
    return { status: res.statusCode, headers, stream: res };
  }
}

function createStorage(cfg) {
  if (cfg.storage === 'local') return new LocalStorage(cfg.localPath);
  return new RcloneStorage({ rcUrl: cfg.rcloneUrl, remote: cfg.remote, rcUser: cfg.rcloneUser, rcPass: cfg.rclonePass });
}

module.exports = { createStorage, mimeOf };
