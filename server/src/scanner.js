'use strict';
// Recorre las carpetas de la nube y construye el catálogo a partir de los nombres.
//
//  Películas/  Título (Año)/  pelicula.mp4  poster.jpg  fondo.jpg  pelicula.es.srt
//  Series/     Nombre/        Temporada 1/  S01E01 - Piloto.mp4
const crypto = require('crypto');

const VIDEO = /\.(mp4|m4v|mkv|webm|mov|avi|ts)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const SUB = /\.(srt|vtt)$/i;
const JUNK = /\b(1080p|720p|2160p|4k|uhd|hdr|x26[45]|h\.?26[45]|hevc|bluray|brrip|bdrip|web-?dl|webrip|hdtv|dvdrip|aac|ac3|dts|castellano|latino|dual|vose|subs?|esp|spa|multi)\b.*$/i;

const hash = (s, n = 12) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
const base = (p) => p.split('/').pop();
const noExt = (p) => base(p).replace(/\.[^.]+$/, '');

function parseTitle(raw) {
  let s = raw.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  let year = null;
  // Se usa el último año que deje un título delante ("1917 (2019)", "Blade Runner 2049 2017")
  const years = [...(' ' + s).matchAll(/[\s(\[](19\d{2}|20\d{2})(?=[)\]\s]|$)/g)].filter((y) => y.index > 1);
  const y = years[years.length - 1];
  if (y) { year = parseInt(y[1], 10); s = s.slice(0, y.index - 1); }
  s = s.replace(JUNK, '').replace(/[\s\-–([]+$/, '').trim();
  return { title: s || raw, year };
}

function subLabel(file) {
  const m = /\.([a-z]{2,3}(?:-[a-z]{2})?)\.(srt|vtt)$/i.exec(base(file));
  const code = m ? m[1].toLowerCase() : '';
  const names = { es: 'Español', spa: 'Español', en: 'English', eng: 'English', fr: 'Français', pt: 'Português', it: 'Italiano', de: 'Deutsch', ca: 'Català' };
  return { lang: code || 'es', label: names[code] || (code ? code.toUpperCase() : 'Subtítulos') };
}

function pickImages(files) {
  const imgs = files.filter((f) => IMAGE.test(f.path));
  const find = (re) => imgs.find((f) => re.test(noExt(f.path)));
  const poster = find(/^(poster|cover|folder|portada|caratula)$/i) || find(/poster|cover|portada/i);
  const backdrop = find(/^(backdrop|fanart|fondo|background)$/i) || find(/backdrop|fanart|fondo/i);
  return { poster: poster || imgs.find((f) => f !== backdrop) || null, backdrop: backdrop || null };
}

function parseEpisode(relInShow) {
  const name = noExt(relInShow);
  const folder = relInShow.split('/').slice(0, -1).join('/');
  const sm = /(?:temporada|season|temp|\bt|\bs)\s*(\d{1,2})\b/i.exec(folder);
  const m = /s(\d{1,2})\s*[ex](\d{1,3})/i.exec(name) || /\b(\d{1,2})x(\d{1,3})\b/i.exec(name);
  // Si la carpeta indica la temporada, manda la carpeta
  if (m) return { season: sm ? +sm[1] : +m[1], episode: +m[2], rest: name.slice(m.index + m[0].length) };
  const em = /(?:episodio|episode|cap[ií]tulo|cap|ep|e)\s*(\d{1,3})/i.exec(name) || /^(\d{1,3})\b/.exec(name);
  return { season: sm ? +sm[1] : 1, episode: em ? +em[1] : null, rest: em ? name.slice(em.index + em[0].length) : name };
}

function cleanEpName(rest) {
  const s = rest.replace(/[._]+/g, ' ').replace(JUNK, '').replace(/^[\s\-–:]+|[\s\-–]+$/g, '').trim();
  return s || null;
}

function groupByTop(list) {
  const groups = new Map();
  for (const f of list) {
    const parts = f.path.split('/');
    const key = parts.length > 1 ? parts[0] : noExt(f.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return groups;
}

// Tipo de una sección según su nombre (o, si no lo dice, según su contenido)
function sectionKind(name, files) {
  if (/saga|colecci[oó]n|trilog/i.test(name)) return 'saga';
  if (/pel[ií]cula|movie|film|cine|documental/i.test(name)) return 'movie';
  if (/serie|novela|show|\btv\b|temporada|season/i.test(name)) return 'series';
  return files.some((f) => /s\d{1,2}\s*e\d{1,3}|\b\d{1,2}x\d{1,3}\b|temporada|season/i.test(f.path)) ? 'series' : 'movie';
}
// Nombre bonito: "PELICULAS ANIMACION" -> "Películas Animación"
const ACCENTS = { peliculas: 'Películas', pelicula: 'Película', animacion: 'Animación', documentales: 'Documentales', comedia: 'Comedia', accion: 'Acción', infantiles: 'Infantiles', clasicos: 'Clásicos', musica: 'Música' };
const plain = (w) => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const prettySection = (n) => n.trim().split(/\s+/).map((w) => {
  const k = plain(w);
  if (ACCENTS[k]) return ACCENTS[k];
  if (w.length <= 3 && w === w.toUpperCase() && /[A-Z]/.test(w) && !['DE', 'LA', 'Y', 'EL', 'LOS', 'LAS', 'DEL'].includes(w)) return w; // siglas: TV, DC…
  const low = w.toLowerCase();
  return ['de', 'la', 'y', 'el', 'los', 'las', 'del'].includes(low) ? low : low.charAt(0).toUpperCase() + low.slice(1);
}).join(' ');
// Orden del menú (sin importar mayúsculas ni tildes). Las que no estén aquí van detrás, por orden alfabético.
const SECTION_ORDER = ['peliculas', 'series', 'peliculas anime', 'peliculas animacion', 'series infantiles', 'series anime', 'documentales', 'docuseries', 'telenovelas', 'programas de tv', 'sagas'];
const sectionRank = (id) => { const i = SECTION_ORDER.indexOf(plain(id).replace(/\s+/g, ' ').trim()); return i < 0 ? 999 : i; };

// Construye una sección (películas o series) a partir de su listado
function buildSection(list, root, kind, section, idPrefix, titles, files) {
  const reg = (f, k) => {
    const id = hash(root + ':' + f.path, 16);
    files[id] = { root, path: f.path, size: f.size, kind: k };
    return id;
  };
  for (const [key, group] of groupByTop(list)) {
    const videos = group.filter((f) => VIDEO.test(f.path));
    if (!videos.length) continue;
    const { title, year } = parseTitle(key);
    if (kind === 'saga') {
      const imgs = pickImages(group.filter((f) => f.path.split('/').length <= 2));
      const id = hash('saga:' + idPrefix + key);
      // Una película por subcarpeta (o por archivo suelto dentro de la saga)
      const byMovie = new Map();
      for (const v of videos) {
        const parts = v.path.split('/');
        const mk = parts.length > 2 ? parts[1] : noExt(v.path);
        const cur = byMovie.get(mk);
        if (!cur || v.size > cur.size) byMovie.set(mk, v);
      }
      const movies = [...byMovie.entries()].map(([mk, v]) => {
        const pt = parseTitle(mk.replace(/^\d{1,2}\s*[-._)]\s*/, ''));
        const stem = v.path.replace(/\.[^.]+$/, '');
        const subs = group.filter((f) => SUB.test(f.path) && (f.path.startsWith(stem) || f.path.split('/')[1] === mk))
          .map((f) => ({ fileId: reg(f, 'sub'), ...subLabel(f.path) }));
        return { v, order: mk, year: pt.year, name: pt.title + (pt.year ? ` (${pt.year})` : ''), subs };
      });
      // Orden: por número delante ("01 - …"), si no por año, si no por nombre
      movies.sort((a, b) => {
        const na = parseInt(a.order, 10), nb = parseInt(b.order, 10);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        if (a.year && b.year && a.year !== b.year) return a.year - b.year;
        return a.order.localeCompare(b.order, 'es', { numeric: true });
      });
      let latest = '';
      const list = movies.map((m, i) => {
        if ((m.v.mtime || '') > latest) latest = m.v.mtime || '';
        return { fileId: reg(m.v, 'video'), season: 1, episode: i + 1, name: m.name, subs: m.subs };
      });
      titles[id] = {
        id, type: 'series', saga: true, section, title, year, folder: key, seasons: { 1: list },
        posterFile: imgs.poster ? reg(imgs.poster, 'image') : null,
        backdropFile: imgs.backdrop ? reg(imgs.backdrop, 'image') : null,
        mtime: latest,
      };
    } else if (kind === 'movie') {
      const main = [...videos].sort((a, b) => b.size - a.size)[0];
      const imgs = pickImages(group);
      const id = hash('movie:' + idPrefix + key);
      titles[id] = {
        id, type: 'movie', section, title, year, folder: key,
        fileId: reg(main, 'video'),
        subs: group.filter((f) => SUB.test(f.path)).map((f) => ({ fileId: reg(f, 'sub'), ...subLabel(f.path) })),
        posterFile: imgs.poster ? reg(imgs.poster, 'image') : null,
        backdropFile: imgs.backdrop ? reg(imgs.backdrop, 'image') : null,
        mtime: main.mtime,
      };
    } else {
      const imgs = pickImages(group.filter((f) => f.path.split('/').length <= 2));
      const id = hash('series:' + idPrefix + key);
      const seasons = {};
      let latest = '';
      const autoNum = {};
      for (const v of [...videos].sort((a, b) => a.path.localeCompare(b.path, 'es', { numeric: true }))) {
        const rel = v.path.split('/').slice(1).join('/') || v.path;
        const ep = parseEpisode(rel);
        autoNum[ep.season] = (autoNum[ep.season] || 0) + 1;
        const number = ep.episode || autoNum[ep.season];
        const stem = v.path.replace(/\.[^.]+$/, '');
        const subs = group.filter((f) => SUB.test(f.path) && f.path.startsWith(stem)).map((f) => ({ fileId: reg(f, 'sub'), ...subLabel(f.path) }));
        (seasons[ep.season] = seasons[ep.season] || []).push({ fileId: reg(v, 'video'), season: ep.season, episode: number, name: cleanEpName(ep.rest), subs });
        if ((v.mtime || '') > latest) latest = v.mtime || '';
      }
      for (const s of Object.values(seasons)) s.sort((a, b) => a.episode - b.episode);
      titles[id] = {
        id, type: 'series', section, title, year, folder: key, seasons,
        posterFile: imgs.poster ? reg(imgs.poster, 'image') : null,
        backdropFile: imgs.backdrop ? reg(imgs.backdrop, 'image') : null,
        mtime: latest,
      };
    }
  }
}

// libraryList: todos los archivos bajo la carpeta raíz (p. ej. NubeCine/)
// Cada carpeta de primer nivel es una sección.
function buildLibrary(libraryList, libraryPath) {
  const titles = {}, files = {}, sections = [];
  const bySection = new Map();
  for (const f of libraryList) {
    const parts = f.path.split('/');
    if (parts.length < 2) continue; // archivos sueltos en la raíz: se ignoran
    const sec = parts[0];
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push({ ...f, path: parts.slice(1).join('/') });
  }
  for (const [sec, list] of bySection) {
    const kind = sectionKind(sec, list);
    const root = libraryPath.replace(/\/+$/, '') + '/' + sec;
    // Las secciones "Peliculas" y "Series" mantienen los identificadores de versiones anteriores
    const idPrefix = /^(peliculas|series)$/i.test(sec) ? '' : sec + '/';
    const before = Object.keys(titles).length;
    buildSection(list, root, kind, sec, idPrefix, titles, files);
    const count = Object.keys(titles).length - before;
    if (count) sections.push({ id: sec, name: prettySection(sec), type: kind, count });
  }
  sections.sort((a, b) => sectionRank(a.id) - sectionRank(b.id) || a.name.localeCompare(b.name, 'es'));
  return { titles, files, sections };
}

// Campos que el administrador puede editar y que se conservan entre escaneos
const EDITABLE = ['title', 'year', 'overview', 'posterUrl', 'backdropUrl', 'genres', 'rating', 'hidden'];

function mergeCatalog(oldTitles, fresh) {
  const now = new Date().toISOString();
  for (const [id, t] of Object.entries(fresh)) {
    const old = oldTitles[id];
    t.addedAt = old?.addedAt || now;
    t.edited = old?.edited || {};
    t.meta = old?.meta || {}; // datos de TMDB
    for (const k of EDITABLE) if (k in t.edited) t[k] = t.edited[k];
  }
  return fresh;
}

async function enrichWithTMDB(titles, apiKey, log = () => {}) {
  if (!apiKey) return 0;
  let n = 0;
  for (const t of Object.values(titles)) {
    if (t.meta && t.meta.tmdbChecked) continue;
    try {
      const kind = t.saga ? 'collection' : t.type === 'movie' ? 'movie' : 'tv';
      const u = new URL(`https://api.themoviedb.org/3/search/${kind}`);
      u.searchParams.set('api_key', apiKey);
      u.searchParams.set('query', t.title);
      u.searchParams.set('language', 'es-ES');
      if (t.year && kind !== 'collection') u.searchParams.set(kind === 'movie' ? 'year' : 'first_air_date_year', t.year);
      const r = await fetch(u);
      const j = await r.json();
      const hit = (j.results || [])[0];
      t.meta = { tmdbChecked: true };
      if (hit) {
        t.meta.overview = hit.overview || null;
        t.meta.posterUrl = hit.poster_path ? 'https://image.tmdb.org/t/p/w500' + hit.poster_path : null;
        t.meta.backdropUrl = hit.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + hit.backdrop_path : null;
        t.meta.rating = hit.vote_average ? Math.round(hit.vote_average * 10) / 10 : null;
        t.meta.year = parseInt((hit.release_date || hit.first_air_date || '').slice(0, 4), 10) || null;
        n++;
      }
    } catch (e) {
      log('TMDB: ' + e.message);
    }
  }
  return n;
}

module.exports = { buildLibrary, sectionKind, prettySection, sectionRank, mergeCatalog, enrichWithTMDB, parseTitle, parseEpisode, EDITABLE };
