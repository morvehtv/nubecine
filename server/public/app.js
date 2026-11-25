/* NubeCine — aplicación web (sin dependencias). Funciona con ratón, táctil, teclado y mando de TV. */
(() => {
'use strict';

// ---------------- Utilidades ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
const isTV = (window.NubeTV && window.NubeTV.isTV) ? !!window.NubeTV.isTV() : /Android TV|AFT[A-Z]|BRAVIA|SmartTV|SMART-TV|Tizen|Web0S|GoogleTV/i.test(navigator.userAgent);
if (isTV) document.body.classList.add('tv');

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">10</text></svg>',
  cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3" stroke-linecap="round"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 5.5v13a1 1 0 0 0 1.5.86L16 13.5V18a1 1 0 0 0 2 0V6a1 1 0 0 0-2 0v4.5L6.5 4.64A1 1 0 0 0 5 5.5z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET', credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined, keepalive: !!opts.keepalive,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.allow401) { state.me = null; go('/login'); throw new Error('auth'); }
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

const state = { me: null, siteName: 'NubeCine', requireInvite: false, catalog: null, sections: null, depth: 0 };

// Póster de reserva con degradado según el título
function placeholder(title) {
  let h = 0; for (const c of String(title)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = h % 360, b = (a + 40) % 360;
  return `<div class="placeholder" style="background:linear-gradient(160deg,hsl(${a} 45% 28%),hsl(${b} 55% 12%))">${esc(title)}</div>`;
}
function posterHTML(t, wide) {
  const src = wide ? (t.backdrop || t.poster) : t.poster;
  return src ? `<img loading="lazy" src="${esc(src)}" alt="" onerror="this.outerHTML=window.__ph(this.dataset.t)" data-t="${esc(t.title)}">` : placeholder(t.title);
}
window.__ph = (t) => placeholder(t);

function cardHTML(t, opts = {}) {
  const wide = !!opts.wide;
  const pct = opts.progress ? Math.min(100, Math.round((opts.progress.t / (opts.progress.d || 1)) * 100)) : 0;
  const href = opts.play ? `#/ver/${t.fileId}` : `#/t/${t.id}`;
  const sub = opts.sub ?? [t.year, t.type === 'series' ? `${t.seasonCount} temp.` : null].filter(Boolean).join(' · ');
  return `<a class="card focusable${wide ? ' wide' : ''}" href="${href}">
    <div class="poster">${posterHTML(t, wide)}${t.type === 'series' && !wide ? '<span class="badge">SERIE</span>' : ''}${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>
    <div class="label">${esc(t.title)}</div><div class="sublabel">${esc(sub)}</div></a>`;
}

// ---------------- Navegación con mando (navegación espacial) ----------------
function scopeEl() { return $('.player') || $('.dialog-back') || document; }
function visible(el) {
  if (el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}
function focusEl(el) {
  if (!el) return;
  $$('.focused').forEach((x) => x.classList.remove('focused'));
  el.classList.add('focused');
  el.focus({ preventScroll: true });
  const track = el.closest('.row-track');
  if (track) {
    const r = el.getBoundingClientRect(), tr = track.getBoundingClientRect();
    if (r.left < tr.left + 40 || r.right > tr.right - 40) track.scrollBy({ left: r.left - tr.left - 48, behavior: 'smooth' });
  }
  if (!el.closest('#topbar') && !el.closest('.player')) {
    const r = el.getBoundingClientRect();
    if (r.top < 90 || r.bottom > innerHeight - 30) {
      const top = el.closest('.hero') ? 0 : scrollY + r.top - innerHeight / 2 + r.height / 2;
      scrollTo({ top, behavior: 'smooth' });
    }
  }
}
function moveFocus(dir) {
  const all = $$('.focusable', scopeEl()).filter(visible);
  if (!all.length) return false;
  const cur = document.activeElement;
  if (!cur || !all.includes(cur)) { focusEl(all.find((e) => !e.closest('#topbar')) || all[0]); return true; }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  // La barra superior solo se alcanza subiendo cuando ya no hay nada más arriba
  const inBar = (el) => !!el.closest('#topbar');
  const curBar = inBar(cur);
  const pass = (list) => pick(list.filter((el) => (dir === 'left' || dir === 'right') ? inBar(el) === curBar : true));
  const pick = (list) => {
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    let main, cross;
    const overlapY = b.top < a.bottom && b.bottom > a.top;
    if (dir === 'right') { main = b.left - a.right; cross = Math.abs(by - ay); if (bx <= ax || !overlapY) continue; }
    else if (dir === 'left') { main = a.left - b.right; cross = Math.abs(by - ay); if (bx >= ax || !overlapY) continue; }
    else if (dir === 'down') { main = b.top - a.bottom; cross = Math.abs(bx - ax); if (by <= ay + 2) continue; }
    else { main = a.top - b.bottom; cross = Math.abs(bx - ax); if (by >= ay - 2) continue; }
    const score = Math.max(main, -a.height / 2) + cross * (dir === 'left' || dir === 'right' ? 3 : 0.6);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
  };
  let best;
  if (!curBar && (dir === 'up' || dir === 'down')) best = pass(all.filter((el) => !inBar(el))) || (dir === 'up' ? pass(all.filter(inBar)) : null);
  else if (curBar && dir === 'down') best = pick(all.filter((el) => !inBar(el) && el.getBoundingClientRect().bottom > 0)) || null;
  else best = pass(all);
  if (best) { focusEl(best); return true; }
  return false;
}

function handleBack() {
  const dlg = $('.dialog-back'); if (dlg) { dlg.remove(); return true; }
  if ($('.player .menu')) { $('.player .menu').remove(); return true; }
  if ($('.player') && window.handlePlayerBack) { window.handlePlayerBack(); return true; }
  const route = location.hash.replace(/^#/, '') || '/';
  if (route === '/' || route === '/login') return false;
  if (state.depth > 0) history.back(); else go('/');
  return true;
}
window.handleBack = handleBack; // la app de Android TV llama a esta función con el botón "Atrás"

document.addEventListener('keydown', (e) => {
  if (state.playerKeys && state.playerKeys(e)) return;
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  const dirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  if (dirs[e.key]) {
    if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    if (moveFocus(dirs[e.key])) e.preventDefault();
  } else if (e.key === 'Enter' && !typing && document.activeElement?.classList.contains('focusable')) {
    e.preventDefault(); document.activeElement.click();
  } else if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing)) {
    if (handleBack()) e.preventDefault();
  }
});
document.addEventListener('mousemove', () => $$('.focused').forEach((x) => x.classList.remove('focused')), { passive: true });

// ---------------- Secciones (una por carpeta en la nube) ----------------
const secHref = (s) => '#/s/' + encodeURIComponent(s.id);
function drawNav() {
  const el = $('#nav-sections'); if (!el) return;
  el.innerHTML = (state.sections || []).map((s) => `<a href="${secHref(s)}" class="focusable" data-nav="s:${esc(s.id)}">${esc(s.name)}</a>`).join('');
  markActive();
}
function markActive() {
  const [, seg, arg] = (location.hash.replace(/^#/, '') || '/').split('/');
  const key = seg === 's' ? 's:' + decodeURIComponent(arg || '') : seg === 'peliculas' ? 's:Peliculas' : seg === 'series' ? 's:Series' : (seg || 'home');
  $$('#topbar nav a').forEach((x) => x.classList.toggle('active', x.dataset.nav === key));
}
async function loadCatalog() {
  const c = state.catalog = await api('/api/catalog');
  state.sections = c.sections || [];
  drawNav();
  return c;
}

// ---------------- Router ----------------
let cleanup = null;
function go(path) { location.hash = '#' + path; }
window.addEventListener('hashchange', () => { state.depth++; render(); });

async function render() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  state.playerKeys = null;
  const path = location.hash.replace(/^#/, '') || '/';
  const [, seg, arg] = path.split('/');

  if (!state.me && seg !== 'login' && seg !== 'registro') {
    try { state.me = await api('/api/me', { allow401: true }); } catch { state.me = null; }
    if (!state.me) return go('/login');
  }
  const top = $('#topbar');
  top.hidden = !state.me || seg === 'login' || seg === 'registro' || seg === 'ver';
  if (state.me) {
    $('#nav-admin').hidden = !state.me.admin;
    $('#account-btn').textContent = state.me.username[0].toUpperCase();
  }
  if (state.me && !state.sections && seg !== 'login' && seg !== 'registro') { try { await loadCatalog(); } catch {} }
  markActive();
  window.scrollTo(0, 0);

  try {
    switch (seg || '') {
      case 'login': return renderAuth('login');
      case 'registro': return renderAuth('registro');
      case '': return await renderHome();
      case 's': return await renderGrid(decodeURIComponent(arg || ''));
      case 'peliculas': return await renderGrid('Peliculas');
      case 'series': return await renderGrid('Series');
      case 'mi-lista': return await renderGrid('mylist');
      case 'buscar': return await renderSearch();
      case 't': return await renderTitle(arg);
      case 'ver': return await renderPlayer(arg);
      case 'admin': return await renderAdmin(arg || 'contenido');
      case 'cuenta': return renderAccount();
      default: go('/');
    }
  } catch (e) {
    if (e.message !== 'auth') app.innerHTML = `<div class="page"><div class="empty">${esc(e.message)}</div></div>`;
  }
}
function autofocus(sel) {
  if (!isTV) return;
  requestAnimationFrame(() => focusEl($(sel) || $$('.focusable', app).find(visible)));
}

// ---------------- Login / Registro ----------------
function renderAuth(mode) {
  const reg = mode === 'registro';
  app.innerHTML = `<div class="auth-wrap"><form class="auth-card" autocomplete="on">
    <div class="brand"><span class="brand-mark"></span>${esc(state.siteName)}</div>
    <p class="sub">${reg ? (state.requireInvite ? 'Crea tu cuenta con el código de invitación.' : 'Crea tu cuenta para empezar a ver.') : 'Inicia sesión para ver tus películas y series.'}</p>
    <div class="field"><label for="u">Usuario</label><input class="input focusable" id="u" name="username" autocomplete="username" required></div>
    <div class="field"><label for="p">Contraseña</label><input class="input focusable" id="p" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required></div>
    ${reg && state.requireInvite ? '<div class="field"><label for="c">Código de invitación</label><input class="input focusable" id="c" name="inviteCode" required></div>' : ''}
    <div class="error" id="err"></div>
    <button class="btn primary focusable" type="submit">${reg ? 'Crear cuenta' : 'Entrar'}</button>
    <div class="switch">${reg ? '¿Ya tienes cuenta? <a class="focusable" href="#/login">Inicia sesión</a>' : '¿No tienes cuenta? <a class="focusable" href="#/registro">Regístrate</a>'}</div>
  </form></div>`;
  const form = $('form', app);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    const btn = $('button', form); btn.disabled = true;
    try {
      state.me = await api(reg ? '/api/register' : '/api/login', { method: 'POST', body, allow401: true });
      go('/');
    } catch (err) { $('#err').textContent = err.message; btn.disabled = false; }
  });
  autofocus('#u');
}

// ---------------- Inicio ----------------
function heroHTML(t, buttons) {
  const bg = t.backdrop || t.poster;
  return `<section class="hero">
    <div class="hero-bg" style="${bg ? `background-image:url('${esc(bg)}')` : 'background:linear-gradient(120deg,#2a2112,#0d1220)'}"></div>
    <div class="hero-content">
      <h1>${esc(t.title)}</h1>
      <div class="meta">${t.year ? `<span>${t.year}</span>` : ''}${t.rating ? `<span class="star">★ ${t.rating}</span>` : ''}
        <span class="pill">${t.type === 'series' ? `Serie · ${t.seasonCount} temporada${t.seasonCount > 1 ? 's' : ''}` : 'Película'}</span>
        ${(t.genres || []).slice(0, 3).map((g) => `<span>${esc(g)}</span>`).join('')}</div>
      ${t.overview ? `<p>${esc(t.overview)}</p>` : ''}
      <div class="actions">${buttons}</div>
    </div></section>`;
}
function rowHTML(title, items, mapper) {
  if (!items.length) return '';
  return `<section class="row"><h2>${esc(title)}</h2><div class="row-track">${items.map(mapper).join('')}</div></section>`;
}

async function renderHome() {
  const c = await loadCatalog();
  if (!c.items.length) {
    app.innerHTML = `<div class="page"><div class="empty"><h2>Todavía no hay contenido</h2>
      ${state.me.admin ? `Sube tus vídeos a la nube y pulsa <b>Escanear</b> en el panel de administración.<br><br><a class="btn primary focusable" href="#/admin">Ir al panel</a>` : 'El administrador aún no ha añadido películas ni series.'}</div></div>`;
    return autofocus('.btn');
  }
  const recent = [...c.items].sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  const pool = recent.slice(0, 12).filter((t) => t.backdrop || t.poster);
  const hero = pool[Math.floor(Math.random() * pool.length)] || recent[0];
  const cont = c.continue.find((x) => x.id === hero.id);
  app.innerHTML = heroHTML(hero, `
      <a class="btn primary focusable" id="hero-play" href="#/${cont ? 'ver/' + cont.fileId : 't/' + hero.id}">${ICON.play}${cont ? 'Continuar' : (hero.type === 'movie' ? 'Reproducir' : 'Ver serie')}</a>
      <a class="btn focusable" href="#/t/${hero.id}">Más información</a>`) +
    rowHTML('Seguir viendo', c.continue, (x) => cardHTML(x, { wide: true, play: true, progress: x, sub: x.type === 'series' ? `T${x.season} · E${x.episode}` : fmtTime(x.d - x.t) + ' restantes' })) +
    rowHTML('Mi lista', c.mylist, (x) => cardHTML(x)) +
    rowHTML('Añadido recientemente', recent.slice(0, 20), (x) => cardHTML(x)) +
    c.sections.map((s) => rowHTML(s.name, c.items.filter((x) => x.section === s.id).sort((a, b) => a.title.localeCompare(b.title, 'es')), (x) => cardHTML(x))).join('');
  autofocus('#hero-play');
}

// ---------------- Rejillas ----------------
async function renderGrid(kind) {
  const c = await loadCatalog();
  const sec = c.sections.find((s) => s.id === kind);
  let items = kind === 'mylist' ? c.mylist : c.items.filter((x) => x.section === kind);
  const title = kind === 'mylist' ? 'Mi lista' : (sec ? sec.name : kind);
  const genres = [...new Set(items.flatMap((x) => x.genres || []))].sort();
  let sort = 'recent', genre = '';
  const draw = () => {
    let list = items.filter((x) => !genre || (x.genres || []).includes(genre));
    list = [...list].sort(sort === 'az' ? (a, b) => a.title.localeCompare(b.title, 'es') : sort === 'year' ? (a, b) => (b.year || 0) - (a.year || 0) : (a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
    $('#grid').innerHTML = list.length ? list.map((x) => cardHTML(x)).join('') : `<div class="empty">${kind === 'mylist' ? 'Añade títulos a tu lista con el botón «Mi lista».' : 'No hay nada aquí todavía.'}</div>`;
  };
  app.innerHTML = `<div class="page"><h1>${title}</h1>
    <div class="toolbar">
      ${[['recent', 'Recientes'], ['az', 'A–Z'], ['year', 'Año']].map(([k, l]) => `<button class="chip focusable${k === sort ? ' on' : ''}" data-sort="${k}">${l}</button>`).join('')}
      ${genres.length ? '<span style="width:12px"></span>' + genres.map((g) => `<button class="chip focusable" data-genre="${esc(g)}">${esc(g)}</button>`).join('') : ''}
    </div><div class="grid" id="grid"></div></div>`;
  $('.toolbar', app).addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    if (b.dataset.sort) { sort = b.dataset.sort; $$('[data-sort]').forEach((x) => x.classList.toggle('on', x === b)); }
    if (b.dataset.genre !== undefined) { genre = genre === b.dataset.genre ? '' : b.dataset.genre; $$('[data-genre]').forEach((x) => x.classList.toggle('on', x.dataset.genre === genre)); }
    draw();
  });
  draw();
  autofocus('.grid .card');
}

// ---------------- Búsqueda ----------------
async function renderSearch() {
  const c = await loadCatalog();
  app.innerHTML = `<div class="page"><h1>Buscar</h1>
    <input class="input focusable" id="q" placeholder="Título de película o serie" style="max-width:560px;font-size:18px;margin-bottom:24px" autocomplete="off">
    <div class="grid" id="grid"></div></div>`;
  const q = $('#q');
  const draw = () => {
    const n = norm(q.value.trim());
    const list = n ? c.items.filter((x) => norm(x.title).includes(n) || norm(x.overview).includes(n)) : [];
    $('#grid').innerHTML = !n ? '' : list.length ? list.map((x) => cardHTML(x)).join('') : '<div class="empty">Sin resultados.</div>';
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q.blur(); moveFocus('down'); } });
  q.focus();
}

// ---------------- Ficha ----------------
async function renderTitle(id) {
  const t = await api('/api/title/' + id);
  let playFile = t.fileId, playLabel = 'Reproducir', season = t.seasons?.[0]?.season;
  if (t.type === 'movie' && t.progress && t.progress.t > 30 && t.progress.t / t.progress.d < 0.93) playLabel = 'Continuar · ' + fmtTime(t.progress.d - t.progress.t) + ' restantes';
  if (t.type === 'series') {
    const eps = t.seasons.flatMap((s) => s.episodes);
    const watched = eps.filter((e) => e.progress).sort((a, b) => b.progress.at - a.progress.at)[0];
    let target = eps[0];
    if (watched) {
      const done = watched.progress.t / (watched.progress.d || 1) > 0.93;
      target = done ? eps[eps.indexOf(watched) + 1] || watched : watched;
    }
    playFile = target.fileId; season = target.season;
    playLabel = (watched ? 'Continuar' : 'Ver') + ` T${target.season}:E${target.episode}`;
  }
  app.innerHTML = `<div class="detail">${heroHTML(t, `
      <a class="btn primary focusable" id="play" href="#/ver/${playFile}">${ICON.play}${esc(playLabel)}</a>
      <button class="btn focusable" id="mylist">${t.inList ? ICON.check + 'En mi lista' : ICON.plus + 'Mi lista'}</button>
      ${state.me.admin ? `<a class="btn ghost focusable" href="#/admin/contenido?edit=${t.id}">Editar</a>` : ''}`)}
    <div class="detail-body">${t.type === 'series' ? `<div>
      <div class="seasons">${t.seasons.map((s) => `<button class="chip focusable${s.season === season ? ' on' : ''}" data-season="${s.season}">Temporada ${s.season}</button>`).join('')}</div>
      <div class="episodes" id="eps"></div></div>` : ''}</div></div>`;
  $('#mylist').addEventListener('click', async (e) => {
    const r = await api('/api/mylist/' + t.id, { method: 'POST' });
    e.currentTarget.innerHTML = r.inList ? ICON.check + 'En mi lista' : ICON.plus + 'Mi lista';
    toast(r.inList ? 'Añadido a tu lista' : 'Quitado de tu lista');
  });
  if (t.type === 'series') {
    const drawEps = () => {
      const s = t.seasons.find((x) => x.season === season);
      $('#eps').innerHTML = s.episodes.map((e) => {
        const pct = e.progress ? Math.min(100, Math.round(e.progress.t / (e.progress.d || 1) * 100)) : 0;
        return `<a class="episode focusable" href="#/ver/${e.fileId}"><div class="num">${e.episode}</div>
          <div><div class="name">${esc(e.name || 'Episodio ' + e.episode)}</div>
          <div class="small">T${e.season} · E${e.episode}${e.progress?.d ? ' · ' + fmtTime(e.progress.d) : ''}</div>
          ${pct ? `<div class="ep-bar"><i style="width:${pct}%"></i></div>` : ''}</div>
          <span class="go">${ICON.play}</span></a>`;
      }).join('');
    };
    $('.seasons').addEventListener('click', (e) => {
      const b = e.target.closest('[data-season]'); if (!b) return;
      season = +b.dataset.season; $$('[data-season]').forEach((x) => x.classList.toggle('on', x === b)); drawEps();
    });
    drawEps();
  }
  autofocus('#play');
}

// ---------------- Reproductores nativos ----------------
// App Android (TV y móvil): ExoPlayer a pantalla completa.
// iPhone: reproductor de iOS a pantalla completa.
// Al salir de cualquiera de los dos se guarda el progreso y se muestra la ficha.
const hasNative = () => !!(window.NubeTV && window.NubeTV.hasNativePlayer && window.NubeTV.play);
const isIPhone = /iPhone|iPod/.test(navigator.userAgent);
const resumeAt = (p) => (p && p.t > 15 && p.d && p.t / p.d < 0.93 ? p.t - 3 : 0);
const playLabel = (info) => info.title + (info.type === 'series' ? ` · T${info.season}:E${info.episode}${info.episodeName ? ' · ' + info.episodeName : ''}` : '');
function showTitle(titleId) {
  const here = location.hash === '#/t/' + titleId;
  if (here) render(); else go('/t/' + titleId);
}

async function playNativeAndroid(fileId) {
  try {
    const info = await api('/api/play/' + fileId);
    let pref = 'es'; try { pref = localStorage.getItem('subLang') || 'es'; } catch {}
    const subs = [...(info.subs || [])].sort((a, b) => (b.lang === pref) - (a.lang === pref))
      .map((s) => ({ url: location.origin + '/sub/' + s.fileId, lang: s.lang, label: s.label }));
    window.NubeTV.play(location.origin + '/stream/' + fileId, playLabel(info), resumeAt(info.progress), JSON.stringify(pref === 'off' ? [] : subs), fileId);
    state.nativeTitle = info.titleId;
    if (location.hash !== '#/t/' + info.titleId) setTimeout(() => go('/t/' + info.titleId), 300);
  } catch (e) { if (e.message !== 'auth') toast(e.message); }
}
window.onNativePlayerClosed = async (fileId, t, d) => {
  if (d > 0) { try { await api('/api/progress', { method: 'POST', body: { fileId, t, d } }); } catch {} }
  if (state.nativeTitle) showTitle(state.nativeTitle);
};

function playIPhone(fileId) {
  // Se crea y reproduce dentro del mismo toque: así iOS abre su reproductor a pantalla completa
  $('#ios-video')?.remove();
  const v = document.createElement('video');
  v.id = 'ios-video'; v.preload = 'auto'; v.src = '/stream/' + fileId;
  v.setAttribute('x-webkit-airplay', 'allow');
  v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  v.play().catch(() => {});
  let info = null, lastSave = 0, closed = false;
  const save = () => { if (v.duration && isFinite(v.duration)) { lastSave = Date.now(); api('/api/progress', { method: 'POST', body: { fileId, t: v.currentTime, d: v.duration }, keepalive: true }).catch(() => {}); } };
  const close = () => {
    if (closed) return; closed = true;
    save(); v.pause(); setTimeout(() => v.remove(), 500);
    if (info) showTitle(info.titleId);
  };
  api('/api/play/' + fileId).then((i) => {
    info = i;
    for (const s of i.subs || []) {
      const tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.src = '/sub/' + s.fileId; tr.srclang = s.lang; tr.label = s.label;
      if (s.lang === 'es') tr.default = true;
      v.appendChild(tr);
    }
    const start = resumeAt(i.progress);
    if (start) { if (v.readyState >= 1) v.currentTime = start; else v.addEventListener('loadedmetadata', () => { v.currentTime = start; }, { once: true }); }
  }).catch(() => {});
  v.addEventListener('timeupdate', () => { if (Date.now() - lastSave > 10000) save(); });
  v.addEventListener('pause', save);
  v.addEventListener('webkitendfullscreen', close);
  v.addEventListener('ended', () => { try { v.webkitExitFullscreen(); } catch {} close(); });
  v.addEventListener('error', () => { toast('No se pudo reproducir el vídeo. Usa MP4 (H.264/AAC).'); close(); });
}

// Cualquier enlace "Reproducir/Continuar" abre el reproductor nativo cuando lo hay
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="#/ver/"]');
  if (!a || (!hasNative() && !isIPhone)) return;
  e.preventDefault(); e.stopPropagation();
  const fileId = decodeURIComponent(a.getAttribute('href').slice(6));
  if (hasNative()) playNativeAndroid(fileId); else playIPhone(fileId);
}, true);

// ---------------- Reproductor ----------------
async function renderPlayer(fileId) {
  if (hasNative()) { location.replace('#/'); return playNativeAndroid(fileId); }
  const info = await api('/api/play/' + fileId);
  if (isIPhone) {
    // En iPhone hace falta un toque para abrir el reproductor del sistema
    app.innerHTML = `<div class="page"><h1>${esc(playLabel(info))}</h1>
      <div class="actions"><button class="btn primary focusable" id="ios-play">${ICON.play}Reproducir</button><a class="btn focusable" href="#/t/${esc(info.titleId)}">Volver</a></div></div>`;
    $('#ios-play').onclick = () => playIPhone(fileId);
    return;
  }
  const sub = info.type === 'series' ? `T${info.season} · E${info.episode}${info.episodeName ? ' — ' + info.episodeName : ''}` : '';
  app.innerHTML = `<div class="player">
    <video id="v" preload="auto" playsinline autoplay src="/stream/${esc(fileId)}">
      ${(info.subs || []).map((s, i) => `<track kind="subtitles" src="/sub/${esc(s.fileId)}" srclang="${esc(s.lang)}" label="${esc(s.label)}"${i === 0 && s.lang !== 'es' ? '' : ''}>`).join('')}
    </video>
    <div class="spinner" id="spin"></div>
    <div class="ui">
      <div class="ui-top">
        <button class="icon-btn focusable" id="p-back" aria-label="Volver">${ICON.back}</button>
        <div><div class="t">${esc(info.title)}</div><div class="s">${esc(sub)}</div></div>
      </div>
      <div class="ui-center"><button class="center-btn" id="p-center" aria-label="Reproducir/Pausar">${ICON.pause}</button></div>
      <div class="ui-bottom">
        <div class="seek focusable" id="seek" tabindex="0" role="slider" aria-label="Posición">
          <div class="track"><div class="buf" id="buf"></div><div class="fill" id="fill"></div></div><div class="knob" id="knob"></div>
        </div>
        <div class="controls">
          <button class="icon-btn focusable" id="p-play" aria-label="Reproducir/Pausar">${ICON.pause}</button>
          <button class="icon-btn focusable" id="p-rew" aria-label="Retroceder 10 segundos">${ICON.back10}</button>
          <button class="icon-btn focusable" id="p-fwd" aria-label="Avanzar 10 segundos">${ICON.fwd10}</button>
          <span class="time" id="time">0:00 / 0:00</span>
          ${info.next ? `<button class="btn small focusable" id="p-next">${ICON.next} Siguiente</button>` : ''}
          ${(info.subs || []).length ? `<button class="icon-btn focusable" id="p-cc" aria-label="Subtítulos">${ICON.cc}</button>` : ''}
          ${!isTV && !window.NubeTV ? `<button class="icon-btn focusable" id="p-full" aria-label="Pantalla completa">${ICON.full}</button>` : ''}
        </div>
      </div>
    </div></div>`;
  const player = $('.player'), v = $('#v');
  let lastSave = 0, idleT = null, ended = false, countdown = null;

  const save = (keepalive) => {
    if (!v.duration || !isFinite(v.duration)) return;
    lastSave = Date.now();
    api('/api/progress', { method: 'POST', body: { fileId, t: v.currentTime, d: v.duration }, keepalive }).catch(() => {});
  };
  const wake = () => {
    player.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (!v.paused && !$('.menu', player)) { player.classList.add('idle'); } }, 3500);
  };
  const seekBy = (s) => { if (isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration - 1, v.currentTime + s)); wake(); };
  const toggle = () => { v.paused ? v.play() : v.pause(); wake(); };
  const leave = () => { save(true); if (state.depth > 0) history.back(); else go('/t/' + info.titleId); };
  const playNext = () => { save(true); location.replace('#/ver/' + info.next.fileId); };

  // Subtítulos: por defecto activa español si existe
  const setSub = (idx) => { [...v.textTracks].forEach((tr, i) => { tr.mode = i === idx ? 'showing' : 'disabled'; }); try { localStorage.setItem('subLang', idx >= 0 ? info.subs[idx].lang : 'off'); } catch {} };
  v.addEventListener('loadedmetadata', () => {
    let pref = 'es'; try { pref = localStorage.getItem('subLang') || 'es'; } catch {}
    setSub(pref === 'off' ? -1 : (info.subs || []).findIndex((s) => s.lang === pref));
    const p = info.progress;
    if (p && p.t > 15 && p.d && p.t / p.d < 0.93) { v.currentTime = p.t - 3; toast('Reanudando desde ' + fmtTime(p.t)); }
  }, { once: true });

  v.addEventListener('timeupdate', () => {
    const d = v.duration || 0, pct = d ? (v.currentTime / d) * 100 : 0;
    $('#fill').style.width = pct + '%'; $('#knob').style.left = pct + '%';
    $('#time').textContent = fmtTime(v.currentTime) + ' / ' + fmtTime(d);
    if (v.buffered.length && d) $('#buf').style.width = (v.buffered.end(v.buffered.length - 1) / d * 100) + '%';
    if (Date.now() - lastSave > 10000) save();
  });
  v.addEventListener('play', () => { $('#p-play').innerHTML = ICON.pause; $('#p-center').innerHTML = ICON.pause; wake(); });
  v.addEventListener('pause', () => { $('#p-play').innerHTML = ICON.play; $('#p-center').innerHTML = ICON.play; player.classList.remove('idle'); save(); });
  v.addEventListener('waiting', () => { $('#spin').hidden = false; });
  v.addEventListener('playing', () => { $('#spin').hidden = true; });
  v.addEventListener('canplay', () => { $('#spin').hidden = true; });
  v.addEventListener('error', () => {
    $('#spin').hidden = true;
    toast(v.error && v.error.code === 4 ? 'Este formato de vídeo no es compatible. Usa MP4 (H.264/AAC).' : 'No se pudo cargar el vídeo.');
  });
  v.addEventListener('ended', () => {
    ended = true; save(true);
    if (info.next) {
      let n = 8;
      const b = $('#p-next'); player.classList.remove('idle');
      countdown = setInterval(() => { n--; b.innerHTML = `${ICON.next} Siguiente en ${n}`; if (n <= 0) { clearInterval(countdown); playNext(); } }, 1000);
      focusEl(b);
    } else setTimeout(leave, 1500);
  });

  $('#p-back').onclick = leave;
  $('#p-play').onclick = toggle;
  $('#p-rew').onclick = () => seekBy(-10);
  $('#p-fwd').onclick = () => seekBy(10);
  if (info.next) $('#p-next').onclick = playNext;
  if ($('#p-full')) $('#p-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : player.requestFullscreen?.());
  if ($('#p-cc')) $('#p-cc').onclick = () => {
    if ($('.menu', player)) return $('.menu', player).remove();
    const active = [...v.textTracks].findIndex((t) => t.mode === 'showing');
    const m = document.createElement('div'); m.className = 'menu';
    m.innerHTML = `<button class="focusable${active < 0 ? ' on' : ''}" data-i="-1">Desactivados</button>` +
      info.subs.map((s, i) => `<button class="focusable${active === i ? ' on' : ''}" data-i="${i}">${esc(s.label)}</button>`).join('');
    m.onclick = (e) => { const b = e.target.closest('button'); if (b) { setSub(+b.dataset.i); m.remove(); focusEl($('#p-cc')); } };
    $('.ui', player).appendChild(m); focusEl($('button', m));
  };
  $('#p-center').onclick = toggle;

  // Barra de progreso: tocar o arrastrar (ratón y dedo)
  const seek = $('#seek');
  let dragging = false;
  const seekPct = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const preview = (pct) => {
    $('#fill').style.width = pct * 100 + '%'; $('#knob').style.left = pct * 100 + '%';
    if (isFinite(v.duration)) $('#time').textContent = fmtTime(pct * v.duration) + ' / ' + fmtTime(v.duration);
  };
  seek.addEventListener('pointerdown', (e) => { dragging = true; seek.setPointerCapture(e.pointerId); preview(seekPct(e)); wake(); e.preventDefault(); });
  seek.addEventListener('pointermove', (e) => { if (dragging) { preview(seekPct(e)); wake(); } });
  const endDrag = (e) => { if (!dragging) return; dragging = false; if (isFinite(v.duration)) v.currentTime = seekPct(e) * v.duration; wake(); };
  seek.addEventListener('pointerup', endDrag);
  seek.addEventListener('pointercancel', () => { dragging = false; });

  // Toques en la pantalla:
  //  - con los controles ocultos, el primer toque solo los muestra (no pulsa nada)
  //  - con el dedo, tocar el fondo oculta/muestra los controles; con el ratón, pausa/reanuda
  let swallowClick = false, lastPointer = 'mouse';
  player.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType || 'mouse';
    if (player.classList.contains('idle')) { swallowClick = true; wake(); }
  }, true);
  player.addEventListener('click', (e) => {
    if (swallowClick) { swallowClick = false; e.stopPropagation(); e.preventDefault(); return; }
    const bg = e.target === v || e.target.classList.contains('ui') || e.target.classList.contains('ui-center') || e.target.classList.contains('ui-top') || e.target.classList.contains('ui-bottom');
    if (!bg) return;
    if (lastPointer === 'mouse') toggle();
    else if (!v.paused) { clearTimeout(idleT); player.classList.add('idle'); }
  }, true);
  player.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wake(); });
  player.addEventListener('dblclick', (e) => { if (lastPointer === 'mouse' && (e.target === v || e.target.classList.contains('ui'))) $('#p-full')?.click(); });

  // Teclado / mando a distancia
  state.playerKeys = (e) => {
    const k = e.key;
    const hidden = player.classList.contains('idle');
    if (k === 'MediaPlayPause' || k === ' ' || k === 'MediaPlay' || k === 'MediaPause') { if (k === 'MediaPlay') v.play(); else if (k === 'MediaPause') v.pause(); else toggle(); e.preventDefault(); return true; }
    if (k === 'MediaFastForward' || k === 'MediaTrackNext') { seekBy(30); e.preventDefault(); return true; }
    if (k === 'MediaRewind' || k === 'MediaTrackPrevious') { seekBy(-30); e.preventDefault(); return true; }
    if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || k === 'Backspace') {
      e.preventDefault();
      if ($('.menu', player)) { $('.menu', player).remove(); return true; }
      if (!hidden && !v.paused) { player.classList.add('idle'); return true; }
      leave(); return true;
    }
    if (hidden) {
      if (k === 'ArrowLeft') seekBy(-10);
      else if (k === 'ArrowRight') seekBy(10);
      else if (k === 'Enter') { toggle(); }
      else { wake(); focusEl(seek); }
      e.preventDefault(); return true;
    }
    wake();
    if (document.activeElement === seek && (k === 'ArrowLeft' || k === 'ArrowRight')) { seekBy(k === 'ArrowLeft' ? -10 : 10); e.preventDefault(); return true; }
    return false; // el resto lo gestiona la navegación espacial
  };
  const onBack = () => leave();
  window.handlePlayerBack = onBack;
  cleanup = () => {
    if (!ended) save(true);
    clearTimeout(idleT); clearInterval(countdown);
    v.pause(); v.removeAttribute('src'); v.load();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  wake();
  focusEl($('#p-play'));
  v.play().catch(() => { $('#p-play').innerHTML = ICON.play; player.classList.remove('idle'); });
}

// ---------------- Cuenta ----------------
function renderAccount() {
  app.innerHTML = `<div class="page" style="max-width:520px"><h1>Mi cuenta</h1>
    <div class="panel"><h3>${esc(state.me.username)}</h3><p>${state.me.admin ? 'Administrador' : 'Usuario'}</p>
      <div class="actions"><button class="btn focusable" id="logout">Cerrar sesión</button>
      ${window.NubeTV ? '<button class="btn ghost focusable" id="server">Cambiar servidor</button>' : ''}</div></div>
    <form class="panel" id="pw"><h3>Cambiar contraseña</h3>
      <div class="field"><label>Contraseña actual</label><input class="input focusable" type="password" name="current" autocomplete="current-password" required></div>
      <div class="field"><label>Nueva contraseña</label><input class="input focusable" type="password" name="next" autocomplete="new-password" minlength="6" required></div>
      <div class="error" id="err"></div><button class="btn primary focusable">Guardar</button></form></div>`;
  $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); state.me = null; state.sections = null; go('/login'); };
  if ($('#server')) $('#server').onclick = () => window.NubeTV.changeServer();
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); $('#err').textContent = ''; toast('Contraseña cambiada'); }
    catch (err) { $('#err').textContent = err.message; }
  };
  autofocus('#logout');
}

// ---------------- Administración ----------------
function dialog(html) {
  const d = document.createElement('div'); d.className = 'dialog-back';
  d.innerHTML = `<div class="dialog">${html}</div>`;
  d.addEventListener('click', (e) => { if (e.target === d) d.remove(); });
  document.body.appendChild(d);
  requestAnimationFrame(() => focusEl($('.focusable', d)));
  return d;
}
function confirmDialog(text, okLabel = 'Confirmar') {
  return new Promise((resolve) => {
    const d = dialog(`<h3>${esc(text)}</h3><div class="actions"><button class="btn danger focusable" data-ok>${esc(okLabel)}</button><button class="btn focusable" data-no>Cancelar</button></div>`);
    d.querySelector('[data-ok]').onclick = () => { d.remove(); resolve(true); };
    d.querySelector('[data-no]').onclick = () => { d.remove(); resolve(false); };
  });
}

async function renderAdmin(tabArg) {
  if (!state.me.admin) return go('/');
  const [tab, query] = tabArg.split('?');
  const params = new URLSearchParams(query || '');
  const tabs = [['contenido', 'Contenido'], ['usuarios', 'Usuarios'], ['ajustes', 'Ajustes']];
  app.innerHTML = `<div class="page"><h1>Administración</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="chip focusable${k === tab ? ' on' : ''}" href="#/admin/${k}">${l}</a>`).join('')}</div>
    <div id="admin-body"></div></div>`;
  const body = $('#admin-body');

  if (tab === 'contenido') {
    const [titles, settings] = await Promise.all([api('/api/admin/titles'), api('/api/admin/settings')]);
    const ls = settings.lastScan;
    body.innerHTML = `<div class="panel"><h3>Escanear la nube</h3>
        <p>Lee la carpeta <span class="code">${esc(settings.remote)}${esc(settings.libraryPath)}</span>: cada carpeta que crees dentro es una sección del menú. También se hace solo cada pocos minutos.<br>
        ${(settings.sections || []).length ? 'Secciones: ' + settings.sections.map((x) => `<b>${esc(x.name)}</b> (${x.type === 'series' ? 'series' : 'películas'}, ${x.count})`).join(' · ') + '<br>' : ''}
        ${ls ? `Último escaneo: ${new Date(ls.at).toLocaleString('es-ES')} · ${ls.files} archivos · ${ls.titles} títulos` : 'Aún no se ha escaneado.'}</p>
        <button class="btn primary focusable" id="scan">Escanear ahora</button></div>
      <div class="panel"><h3>Títulos (${titles.length})</h3><p>Edita el nombre, la sinopsis o las imágenes. Tus cambios se mantienen al volver a escanear.</p>
      <div style="overflow-x:auto"><table class="table"><thead><tr><th></th><th>Título</th><th>Tipo</th><th>Año</th><th>Carpeta</th><th></th></tr></thead><tbody>
      ${titles.map((t) => `<tr${t.hidden ? ' style="opacity:.45"' : ''}><td>${t.poster ? `<img src="${esc(t.poster)}" alt="" loading="lazy">` : ''}</td>
        <td><b>${esc(t.title)}</b>${t.hidden ? ' (oculto)' : ''}</td><td>${esc((state.sections || []).find((x) => x.id === t.section)?.name || t.section)} · ${t.type === 'movie' ? 'Película' : `${t.episodeCount} ep.`}</td>
        <td>${t.year || ''}</td><td style="font-family:ui-monospace,monospace;font-size:13px;color:var(--muted)">${esc(t.folder)}</td>
        <td><button class="btn small focusable" data-edit="${t.id}">Editar</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    $('#scan').onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Escaneando…';
      try { const r = await api('/api/admin/scan', { method: 'POST' }); toast(`Listo: ${r.titles} títulos`); state.sections = null; await loadCatalog(); renderAdmin('contenido'); }
      catch (err) { toast(err.message); b.disabled = false; b.textContent = 'Escanear ahora'; }
    };
    const edit = (id) => {
      const t = titles.find((x) => x.id === id); if (!t) return;
      const d = dialog(`<h3>Editar «${esc(t.title)}»</h3><form id="ef">
        <div class="field"><label>Título</label><input class="input focusable" name="title" value="${esc(t.title)}"></div>
        <div class="two"><div class="field"><label>Año</label><input class="input focusable" name="year" type="number" value="${esc(t.year || '')}"></div>
        <div class="field"><label>Nota (0–10)</label><input class="input focusable" name="rating" type="number" step="0.1" min="0" max="10" value="${esc(t.rating || '')}"></div></div>
        <div class="field"><label>Géneros (separados por comas)</label><input class="input focusable" name="genres" value="${esc((t.genres || []).join(', '))}"></div>
        <div class="field"><label>Sinopsis</label><textarea class="input focusable" name="overview" rows="4">${esc(t.overview)}</textarea></div>
        <div class="field"><label>Póster (enlace https, vacío = imagen de la carpeta)</label><input class="input focusable" name="posterUrl" value="${esc(t.edited.posterUrl || '')}" placeholder="https://…"></div>
        <div class="field"><label>Fondo (enlace https)</label><input class="input focusable" name="backdropUrl" value="${esc(t.edited.backdropUrl || '')}" placeholder="https://…"></div>
        <label style="display:flex;gap:8px;align-items:center;margin:6px 0 14px"><input type="checkbox" name="hidden" class="focusable" ${t.hidden ? 'checked' : ''}> Ocultar a los usuarios</label>
        <div class="error" id="eerr"></div>
        <div class="actions"><button class="btn primary focusable">Guardar</button><button type="button" class="btn focusable" data-close>Cancelar</button></div></form>`);
      d.querySelector('[data-close]').onclick = () => d.remove();
      d.querySelector('#ef').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target)); f.hidden = !!f.hidden;
        try { await api('/api/admin/title/' + id, { method: 'PUT', body: f }); d.remove(); toast('Guardado'); renderAdmin('contenido'); }
        catch (err) { d.querySelector('#eerr').textContent = err.message; }
      };
    };
    body.addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) edit(b.dataset.edit); });
    if (params.get('edit')) edit(params.get('edit'));
  }

  if (tab === 'usuarios') {
    const [users, settings] = await Promise.all([api('/api/admin/users'), api('/api/admin/settings')]);
    body.innerHTML = `<div class="panel"><h3>Invitar a alguien</h3><p>${settings.requireInvite ? `Comparte el enlace de la web y este código para que se registren: <span class="code">${esc(settings.inviteCode)}</span> (puedes cambiarlo en Ajustes).` : 'El registro está abierto: cualquiera con el enlace de la web puede crear una cuenta. Puedes exigir un código en Ajustes.'}</p></div>
      <div class="panel"><h3>Usuarios (${users.length})</h3><div style="overflow-x:auto"><table class="table"><thead><tr><th>Usuario</th><th>Rol</th><th>Alta</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><b>${esc(u.username)}</b>${u.id === state.me.id ? ' (tú)' : ''}</td><td>${u.admin ? 'Admin' : 'Usuario'}</td>
        <td>${new Date(u.createdAt).toLocaleDateString('es-ES')}</td>
        <td style="white-space:nowrap">${u.id === state.me.id ? '' : `${settings.adminFixed ? '' : `<button class="btn small focusable" data-role="${u.id}" data-admin="${u.admin ? 0 : 1}">${u.admin ? 'Quitar admin' : 'Hacer admin'}</button>`}
        <button class="btn small focusable" data-pass="${u.id}">Nueva contraseña</button>
        <button class="btn small danger focusable" data-del="${u.id}" data-name="${esc(u.username)}">Borrar</button>`}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.role) { await api('/api/admin/users/' + b.dataset.role, { method: 'POST', body: { admin: b.dataset.admin === '1' } }); renderAdmin('usuarios'); }
        if (b.dataset.del && await confirmDialog(`¿Borrar la cuenta de ${b.dataset.name}?`, 'Borrar')) { await api('/api/admin/users/' + b.dataset.del, { method: 'DELETE' }); toast('Usuario borrado'); renderAdmin('usuarios'); }
        if (b.dataset.pass) {
          const d = dialog(`<h3>Nueva contraseña</h3><form><div class="field"><input class="input focusable" name="password" type="text" minlength="6" required></div>
            <div class="actions"><button class="btn primary focusable">Guardar</button></div></form>`);
          d.querySelector('form').onsubmit = async (ev) => { ev.preventDefault(); await api('/api/admin/users/' + b.dataset.pass, { method: 'POST', body: { password: ev.target.password.value } }); d.remove(); toast('Contraseña cambiada'); };
        }
      } catch (err) { toast(err.message); }
    });
  }

  if (tab === 'ajustes') {
    const s = await api('/api/admin/settings');
    body.innerHTML = `<form class="panel" id="sf" style="max-width:560px"><h3>General</h3><p>&nbsp;</p>
        <div class="field"><label>Nombre de la web</label><input class="input focusable" name="siteName" value="${esc(s.siteName)}"></div>
        <label style="display:flex;gap:8px;align-items:center;margin:4px 0 12px"><input type="checkbox" class="focusable" name="requireInvite" ${s.requireInvite ? 'checked' : ''}> Pedir código de invitación para registrarse</label>
        <div class="field"><label>Código de invitación</label><input class="input focusable" name="inviteCode" value="${esc(s.inviteCode)}"></div>
        <button class="btn primary focusable">Guardar</button></form>
      <div class="panel" style="max-width:560px"><h3>Nube</h3><p>Modo: <b>${s.storage === 'local' ? 'carpeta local' : 'rclone'}</b><br>
        Carpeta: <span class="code">${esc(s.remote)}${esc(s.libraryPath)}</span><br>
        Carátulas automáticas (TMDB): ${s.tmdb ? 'activadas' : 'desactivadas'}<br><br>Estos valores se cambian en <span class="code">config.json</span> del servidor.</p></div>`;
    $('#sf').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target)); body.requireInvite = !!body.requireInvite;
      try { await api('/api/admin/settings', { method: 'PUT', body }); toast('Ajustes guardados'); loadConfig(); }
      catch (err) { toast(err.message); }
    };
  }
  autofocus('.tabs .chip.on');
}

// ---------------- Arranque ----------------
async function loadConfig() {
  try {
    const c = await api('/api/config', { allow401: true });
    state.siteName = c.siteName; state.requireInvite = !!c.requireInvite; document.title = c.siteName; $('#brand-name').textContent = c.siteName;
  } catch {}
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
loadConfig().then(render);
})();
