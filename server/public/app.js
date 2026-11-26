/* NubeCine — aplicación web (sin dependencias). Funciona con ratón, táctil, teclado y mando de TV. */
(() => {
'use strict';
// Si algo falla en el navegador, se muestra en pantalla (ayuda a encontrar problemas en móviles)
window.addEventListener('error', (e) => { try { if (e.message) toast('Error: ' + e.message); } catch {} });

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
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/></svg>',
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
  if (!res.ok) { const err = new Error(data.error || 'Error ' + res.status); err.data = data; err.status = res.status; throw err; }
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
  const sub = opts.sub ?? [t.year, t.saga ? `${t.episodeCount} películas` : t.type === 'series' ? `${t.seasonCount} temp.` : null].filter(Boolean).join(' · ');
  return `<a class="card focusable${wide ? ' wide' : ''}" href="${href}">
    <div class="poster">${posterHTML(t, wide)}${t.type === 'series' && !wide ? `<span class="badge">${t.saga ? 'SAGA' : 'SERIE'}</span>` : ''}${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>
    <div class="label">${esc(t.title)}</div><div class="sublabel">${esc(sub)}</div></a>`;
}

// ---------------- Navegación con mando (navegación espacial) ----------------
function scopeEl() { return $('.player') || $('.dialog-back') || ($('#cat-menu') && !$('#cat-menu').hidden ? $('#cat-menu') : document); }
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
    const barH = ($('#topbar') && !$('#topbar').hidden ? $('#topbar').offsetHeight : 0) + 20;
    if (r.top < barH || r.bottom > innerHeight - 30) {
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
  if (!$('#cat-menu').hidden) { toggleCats(false); focusEl($('#cat-btn')); return true; }
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
  const menu = $('#cat-menu'); if (!menu) return;
  menu.innerHTML = (state.sections || []).map((s) => `<a href="${secHref(s)}" class="focusable" data-sec="${esc(s.id)}">${esc(s.name)}</a>`).join('');
  $('#cat-btn').hidden = !(state.sections || []).length;
  markActive();
}
function toggleCats(open) {
  const menu = $('#cat-menu'), btn = $('#cat-btn');
  open = open ?? menu.hidden;
  menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
  if (open) { document.body.classList.remove('bar-hidden'); if (isTV) focusEl($('#cat-menu a.active') || $('#cat-menu a')); }
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#cat-btn')) { toggleCats(); return; }
  if (!e.target.closest('#cat-menu')) toggleCats(false);
});
// La cabecera se esconde al bajar y aparece al subir (o al llevar el foco a ella)
(() => {
  let lastY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    if (!$('#cat-menu').hidden) { lastY = y; return; }
    if (y > lastY + 6 && y > 120) document.body.classList.add('bar-hidden');
    else if (y < lastY - 6 || y < 60) document.body.classList.remove('bar-hidden');
    lastY = y;
  }, { passive: true });
  document.addEventListener('focusin', (e) => { if (e.target.closest && e.target.closest('#topbar, #cat-menu')) document.body.classList.remove('bar-hidden'); });
})();
function markActive() {
  const [, seg, arg] = (location.hash.replace(/^#/, '') || '/').split('/');
  const key = seg === 's' ? 's:' + decodeURIComponent(arg || '') : seg === 'peliculas' ? 's:Peliculas' : seg === 'series' ? 's:Series' : (seg || 'home');
  $$('#topbar nav a').forEach((x) => x.classList.toggle('active', x.dataset.nav === key));
  const sec = key.startsWith('s:') ? (state.sections || []).find((x) => 's:' + x.id === key) : null;
  const btn = $('#cat-btn');
  if (btn) { btn.classList.toggle('active', !!sec); $('#cat-label').textContent = sec ? sec.name : 'Categorías'; }
  $$('#cat-menu a').forEach((x) => x.classList.toggle('active', !!sec && x.dataset.sec === sec.id));
}
async function loadCatalog() {
  const c = state.catalog = await api('/api/catalog');
  state.sections = c.sections || [];
  drawNav();
  return c;
}

// ---------------- Tiempo real ----------------
// El servidor avisa cuando hay contenido nuevo (se refresca la página sin perder la posición)
// y cuando hay una versión nueva de la web (se recarga en cuanto no estés viendo un vídeo).
let live = null;
const isPlaying = () => !!($('.player') || $('#ios-video'));
function startLive() {
  if (live || !window.EventSource) return;
  live = new EventSource('/api/events');
  live.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    if (state.webVersion && d.version !== state.webVersion) reloadWhenIdle();
    state.webVersion = state.webVersion || d.version;
    if (state.catalogVersion != null && d.catalog !== state.catalogVersion) liveRefresh({});
    state.catalogVersion = d.catalog;
  });
  live.addEventListener('version', () => reloadWhenIdle());
  live.addEventListener('catalog', (e) => { const d = JSON.parse(e.data); state.catalogVersion = d.version; liveRefresh(d); });
}
function stopLive() { if (live) { live.close(); live = null; } }
function reloadWhenIdle() {
  state.pendingReload = true;
  if (!isPlaying() && !$('.dialog-back')) location.reload();
}
let refreshT = null;
function liveRefresh(d) {
  if (d.addedCount) toast(d.addedCount === 1 ? 'Nuevo: ' + d.added[0] : `${d.addedCount} títulos nuevos: ${d.added.slice(0, 3).join(', ')}${d.addedCount > 3 ? '…' : ''}`);
  clearTimeout(refreshT);
  refreshT = setTimeout(async () => {
    const seg = (location.hash.replace(/^#/, '') || '/').split('/')[1] || '';
    state.sections = null;
    // No se toca nada mientras ves un vídeo, escribes o tienes un diálogo abierto
    const typing = /input|textarea|select/i.test((document.activeElement || {}).tagName || '');
    if (isPlaying() || $('.dialog-back') || typing || !['', 's', 'mi-lista', 't', 'peliculas', 'series'].includes(seg)) { try { await loadCatalog(); } catch {} return; }
    const y = window.scrollY;
    const href = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('href');
    await render(true);
    window.scrollTo(0, y);
    if (isTV && href) { const el = $(`[href="${CSS.escape(href)}"]`); if (el) focusEl(el); }
  }, 400);
}

// ---------------- Router ----------------
let cleanup = null;
function go(path) { location.hash = '#' + path; }
window.addEventListener('hashchange', () => { state.depth++; render(); });

async function render(keepScroll = false) {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  toggleCats(false); document.body.classList.remove('bar-hidden');
  state.playerKeys = null;
  const path = location.hash.replace(/^#/, '') || '/';
  const [, seg, arg] = path.split('/');
  // Versión nueva pendiente: se aplica al salir del vídeo (o al cambiar de página)
  if (state.pendingReload && seg !== 'ver' && !$('#ios-video')) { location.reload(); return; }

  if (!state.me && seg !== 'login' && seg !== 'registro') {
    try { state.me = await api('/api/me', { allow401: true }); } catch { state.me = null; }
    if (!state.me) return go('/login');
  }
  const top = $('#topbar');
  top.hidden = !state.me || seg === 'login' || seg === 'registro' || seg === 'ver';
  document.body.classList.toggle('has-topbar', !top.hidden);
  if (state.me) {
    $('#nav-admin').hidden = !state.me.admin;
    $('#account-btn').textContent = state.me.username[0].toUpperCase();
  }
  if (state.me && !state.sections && seg !== 'login' && seg !== 'registro') { try { await loadCatalog(); } catch {} }
  markActive();
  if (!keepScroll) window.scrollTo(0, 0);
  if (state.me) startLive();

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
    <p class="sub" id="sub">${reg ? (state.requireInvite ? 'Crea tu cuenta con el código de invitación.' : 'Crea tu cuenta para empezar a ver.') : 'Inicia sesión para ver tus películas y series.'}</p>
    <div id="fields">
    <div class="field"><label for="u">Usuario</label><input class="input focusable" id="u" name="username" autocomplete="username" required></div>
    <div class="field"><label for="p">Contraseña</label><input class="input focusable" id="p" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" ${reg ? 'minlength="8"' : ''} required>
      ${reg ? '<div class="hint">Mínimo 8 caracteres. Evita contraseñas típicas.</div>' : ''}</div>
    ${reg && state.requireInvite ? '<div class="field"><label for="c">Código de invitación</label><input class="input focusable" id="c" name="inviteCode" required></div>' : ''}
    </div>
    <div class="field" id="code-field" hidden><label for="code">Código de verificación (6 cifras)</label>
      <input class="input focusable" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9 ]*"></div>
    <div class="error" id="err"></div>
    <button class="btn primary focusable" type="submit">${reg ? 'Crear cuenta' : 'Entrar'}</button>
    <div class="switch">${reg ? '¿Ya tienes cuenta? <a class="focusable" href="#/login">Inicia sesión</a>' : '¿No tienes cuenta? <a class="focusable" href="#/registro">Regístrate</a>'}</div>
  </form></div>`;
  const form = $('form', app);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    if (!body.code) delete body.code;
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      const r = await api(reg ? '/api/register' : '/api/login', { method: 'POST', body, allow401: true });
      if (r.pending) {
        form.innerHTML = `<div class="brand"><span class="brand-mark"></span>${esc(state.siteName)}</div>
          <h3 style="margin:18px 0 8px">Cuenta creada</h3><p class="sub">Tu cuenta está <b>pendiente de aprobación</b>. Podrás entrar cuando el administrador la acepte.</p>
          <a class="btn primary focusable" href="#/login" style="width:100%">Volver al inicio</a>`;
        return;
      }
      state.me = r; go('/');
    } catch (err) {
      // Verificación en dos pasos: se pide el código
      if (err.data && err.data.need2fa) {
        $('#fields').hidden = true; $('#code-field').hidden = false;
        $('#sub').textContent = 'Abre tu app de autenticación y escribe el código.';
        $('#code').required = true; $('#code').focus();
      }
      $('#err').textContent = err.message; btn.disabled = false;
    }
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
        <span class="pill">${t.saga ? `Saga · ${t.episodeCount} películas` : t.type === 'series' ? `Serie · ${t.seasonCount} temporada${t.seasonCount > 1 ? 's' : ''}` : 'Película'}</span>
        ${(t.genres || []).slice(0, 3).map((g) => `<span>${esc(g)}</span>`).join('')}</div>
      ${t.overview ? `<p>${esc(t.overview)}</p>` : ''}
      ${(t.audio || []).length ? `<div class="meta" style="margin-top:-6px">Audio: ${t.audio.map(esc).join(' · ')}</div>` : ''}
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
    rowHTML('Seguir viendo', c.continue, (x) => cardHTML(x, { wide: true, play: true, progress: x, sub: x.saga ? `Película ${x.episode}` : x.type === 'series' ? `T${x.season} · E${x.episode}` : fmtTime(x.d - x.t) + ' restantes' })) +
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
  let playFile = t.fileId, playLabel = 'Reproducir', season = t.seasons?.[0]?.season, started = false;
  if (t.type === 'movie' && t.progress && t.progress.t > 30 && t.progress.t / t.progress.d < 0.93) { playLabel = 'Continuar · ' + fmtTime(t.progress.d - t.progress.t) + ' restantes'; started = true; }
  if (t.type === 'series') {
    const eps = t.seasons.flatMap((s) => s.episodes);
    const watched = eps.filter((e) => e.progress).sort((a, b) => b.progress.at - a.progress.at)[0];
    let target = eps[0];
    if (watched) {
      const done = watched.progress.t / (watched.progress.d || 1) > 0.93;
      target = done ? eps[eps.indexOf(watched) + 1] || watched : watched;
    }
    playFile = target.fileId; season = target.season;
    started = !!(target.progress && target.progress.t > 30 && target.progress.t / (target.progress.d || 1) < 0.93);
    playLabel = t.saga ? (watched ? 'Continuar: ' : 'Ver: ') + (target.name || 'Película ' + target.episode)
      : (watched ? 'Continuar' : 'Ver') + ` T${target.season}:E${target.episode}`;
  }
  app.innerHTML = `<div class="detail">${heroHTML(t, `
      <a class="btn primary focusable" id="play" href="#/ver/${playFile}">${ICON.play}${esc(playLabel)}</a>
      ${started ? `<a class="btn focusable" id="restart" href="#/ver/${playFile}" data-start="0">${ICON.restart}Desde el principio</a>` : ''}
      <button class="btn focusable" id="mylist">${t.inList ? ICON.check + 'En mi lista' : ICON.plus + 'Mi lista'}</button>
      ${state.me.admin ? `<a class="btn ghost focusable" href="#/admin/contenido?edit=${t.id}">Editar</a>` : ''}`)}
    <div class="detail-body">${t.type === 'series' ? `<div>
      ${t.saga ? '<h2 style="margin:8px 0 14px;font-size:20px">Películas de la saga</h2>' : ''}
      <div class="seasons"${t.saga ? ' hidden' : ''}>${t.seasons.map((s) => `<button class="chip focusable${s.season === season ? ' on' : ''}" data-season="${s.season}">Temporada ${s.season}</button>`).join('')}</div>
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
          <div><div class="name">${esc(e.name || (t.saga ? 'Película ' : 'Episodio ') + e.episode)}</div>
          <div class="small">${t.saga ? 'Película ' + e.episode : `T${e.season} · E${e.episode}`}${e.progress?.d ? ' · ' + fmtTime(e.progress.d) : ''}${(e.audio || []).length > 1 ? ' · ' + e.audio.map(esc).join(', ') : ''}</div>
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
// ---------------- Compatibilidad de formatos ----------------
// Qué sabe reproducir este aparato por sí solo. Lo que no, lo adapta el servidor.
const CAPS = (() => {
  const v = document.createElement('video');
  const ok = (t) => { try { return v.canPlayType(t) !== ''; } catch { return false; } };
  const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) || /iPhone|iPad|iPod/.test(navigator.userAgent);
  return {
    safari,
    mkv: !safari && (ok('video/x-matroska') || ok('video/webm')),   // Chrome, Edge, Firefox, Android
    h264: ok('video/mp4; codecs="avc1.640028"'),
    hevc: ok('video/mp4; codecs="hvc1.1.6.L120.90"') || ok('video/mp4; codecs="hev1.1.6.L120.90"'),
    vp9: ok('video/webm; codecs="vp9"'), av1: ok('video/mp4; codecs="av01.0.08M.08"'),
    ac3: ok('audio/mp4; codecs="ac-3"'), eac3: ok('audio/mp4; codecs="ec-3"'),
    flac: ok('audio/flac') || ok('audio/mp4; codecs="flac"'), opus: ok('audio/webm; codecs="opus"'),
  };
})();
function videoCodecOk(vd) {
  if (!vd || !vd.codec) return true; // sin datos: se intenta tal cual
  switch (vd.codec) {
    case 'h264': return CAPS.h264 && !/10|12|422|444/.test(vd.pixFmt || '') && !/high 10|high 4:2:2|high 4:4:4/i.test(vd.profile || '');
    case 'hevc': return CAPS.hevc;
    case 'vp9': return CAPS.vp9;
    case 'av1': return CAPS.av1;
    case 'vp8': case 'theora': return !CAPS.safari;
    default: return false; // mpeg4/xvid, mpeg2, wmv, vc1, rv…
  }
}
function audioCodecOk(codec) {
  switch (codec || '') {
    case '': case 'aac': case 'mp3': return true;
    case 'opus': return CAPS.opus;
    case 'vorbis': return !CAPS.safari;
    case 'flac': return CAPS.flac;
    case 'ac3': return CAPS.ac3;
    case 'eac3': return CAPS.eac3;
    default: return false; // dts, truehd, pcm raros, wma…
  }
}
function containerOk(info) {
  const ext = info.ext || '';
  if (['mp4', 'm4v', 'mov'].includes(ext)) return true;
  if (ext === 'webm' || ext === 'mkv') return CAPS.mkv;
  return false; // avi, ts, wmv, flv, mpg…
}

// Selecciona la pista de audio preferida (castellano) cuando el navegador lo permite (Safari / iPhone)
function selectAudio(v, info) {
  const tracks = v.audioTracks;
  if (!tracks || tracks.length < 2) return false;
  let idx = info && info.prefAudio != null && info.prefAudio < tracks.length ? info.prefAudio : -1;
  if (idx < 0) {
    let best = 0;
    for (let i = 0; i < tracks.length; i++) {
      const txt = `${tracks[i].language} ${tracks[i].label}`;
      const sc = /castellano|espa[nñ]a|es-es/i.test(txt) ? 100 : /latino|419|lat\b/i.test(txt) ? 10 : /^(es|spa)/i.test(tracks[i].language) || /espa[nñ]ol|spanish/i.test(tracks[i].label) ? 50 : 0;
      if (sc > best) { best = sc; idx = i; }
    }
  }
  if (idx < 0) return false;
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === idx;
  return true;
}
// La app de Android usa el reproductor web (ExoPlayer desincronizaba el audio en algunos vídeos)
const hasNative = () => false;
const isIPhone = /iPhone|iPod/.test(navigator.userAgent);
const resumeAt = (p) => {
  if (state.fromStart) { state.fromStart = false; return 0; }
  return p && p.t > 15 && p.d && p.t / p.d < 0.93 ? p.t - 3 : 0;
};
const playLabel = (info) => info.saga ? (info.episodeName || info.title) : info.title + (info.type === 'series' ? ` · T${info.season}:E${info.episode}${info.episodeName ? ' · ' + info.episodeName : ''}` : '');
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
    const args = [location.origin + '/stream/' + fileId, playLabel(info), resumeAt(info.progress), JSON.stringify(pref === 'off' ? [] : subs), fileId];
    if (window.NubeTV.playWithAudio) {
      window.NubeTV.playWithAudio(...args, JSON.stringify({ pref: info.prefAudio, audio: (info.audio || []).map((a) => ({ label: a.label, lang: a.lang, title: a.title })) }));
    } else window.NubeTV.play(...args);
    state.nativeTitle = info.titleId;
    if (location.hash !== '#/t/' + info.titleId) setTimeout(() => go('/t/' + info.titleId), 300);
  } catch (e) { if (e.message !== 'auth') toast(e.message); }
}
window.onNativePlayerClosed = async (fileId, t, d) => {
  if (d > 0) { try { await api('/api/progress', { method: 'POST', body: { fileId, t, d } }); } catch {} }
  if (state.nativeTitle) showTitle(state.nativeTitle);
};

function playIPhone(fileId) {
  // iPhone/iPad: HLS (formato nativo de Apple). El servidor elige castellano, reanuda donde ibas
  // y convierte la imagen si hace falta. Se crea y reproduce dentro del mismo toque para que
  // iOS abra su reproductor a pantalla completa.
  $('#ios-video')?.remove();
  const fromStart = !!state.fromStart; state.fromStart = false;
  const v = document.createElement('video');
  v.id = 'ios-video'; v.preload = 'auto';
  v.src = `/hls/${encodeURIComponent(fileId)}/index.m3u8${fromStart ? '?inicio=1&nueva=1' : ''}`;
  v.setAttribute('x-webkit-airplay', 'allow');
  v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  v.play().catch(() => {});
  let info = null, start = 0, lastSave = 0, closed = false;
  const save = () => {
    const d = (info && info.duration) || 0;
    if (!d) return;
    lastSave = Date.now();
    api('/api/progress', { method: 'POST', body: { fileId, t: start + v.currentTime, d }, keepalive: true }).catch(() => {});
  };
  const close = () => {
    if (closed) return; closed = true;
    save(); v.pause(); v.remove();
    if (state.pendingReload) { location.hash = info ? '#/t/' + info.titleId : location.hash; location.reload(); return; }
    if (info) showTitle(info.titleId);
  };
  api('/api/play/' + fileId).then((i) => { info = i; }).catch(() => {});
  v.addEventListener('loadedmetadata', () => {
    api('/api/hls-info/' + fileId).then((h) => {
      start = h.start || 0;
      // Subtítulos desplazados al punto donde empieza el vídeo
      for (const sub of (info && info.subs) || []) {
        const tr = document.createElement('track');
        tr.kind = 'subtitles'; tr.src = '/sub/' + sub.fileId; tr.srclang = sub.lang; tr.label = sub.label;
        if (sub.lang === 'es') tr.default = true;
        tr.addEventListener('load', () => { for (const c of tr.track.cues || []) { c.startTime -= start; c.endTime -= start; } });
        v.appendChild(tr);
      }
    }).catch(() => {});
  }, { once: true });
  v.addEventListener('timeupdate', () => { if (Date.now() - lastSave > 10000) save(); });
  v.addEventListener('pause', save);
  v.addEventListener('webkitendfullscreen', close);
  v.addEventListener('ended', () => { try { v.webkitExitFullscreen(); } catch {} close(); });
  v.addEventListener('error', () => { toast('No se pudo reproducir el vídeo.'); close(); });
}

// "Desde el principio": el siguiente vídeo que se abra no reanuda
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="#/ver/"]');
  if (a) state.fromStart = a.dataset.start === '0';
}, true);

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
  const sub = info.saga ? `${info.title} · Película ${info.episode}` : info.type === 'series' ? `T${info.season} · E${info.episode}${info.episodeName ? ' — ' + info.episodeName : ''}` : '';
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
          <button class="icon-btn focusable" id="p-restart" aria-label="Desde el principio" title="Desde el principio">${ICON.restart}</button>
          <span class="time" id="time">0:00 / 0:00</span>
          ${info.next ? `<button class="btn small focusable" id="p-next">${ICON.next} Siguiente</button>` : ''}
          ${(info.audio || []).length > 1 ? `<button class="icon-btn focusable" id="p-audio" aria-label="Idioma del audio">${ICON.audio}</button>` : ''}
          ${(info.subs || []).length ? `<button class="icon-btn focusable" id="p-cc" aria-label="Subtítulos">${ICON.cc}</button>` : ''}
          ${!isTV && !window.NubeTV ? `<button class="icon-btn focusable" id="p-full" aria-label="Pantalla completa">${ICON.full}</button>` : ''}
        </div>
      </div>
    </div></div>`;
  const player = $('.player'), v = $('#v');
  let lastSave = 0, idleT = null, ended = false, countdown = null;
  // En la app del móvil: vídeo en horizontal y a pantalla completa
  try { window.NubeTV && window.NubeTV.fullscreen && window.NubeTV.fullscreen(true); } catch {}

  // ---- Pistas de audio ----
  // Safari cambia de pista él solo. En Chrome/Firefox el servidor prepara el vídeo con la pista
  // elegida ("modo pista"): ese vídeo empieza en 'offset', así que el tiempo real es offset + currentTime.
  let mode = 'direct', offset = 0, audioN = null, seekToken = 0;
  const audios = info.audio || [];
  // Chrome/Firefox reproducen siempre la PRIMERA pista del archivo (aunque otra esté marcada como principal)
  const browserDefault = 0;
  const canNativeSwitch = () => !!(v.audioTracks && v.audioTracks.length > 1);
  const canRemux = () => true; // el servidor siempre puede adaptarlo (aunque no sepa la duración)
  // Modo adaptado: el servidor reempaqueta (y si hace falta convierte la imagen a H.264)
  const media = info.media || {};
  let vmode = videoCodecOk(media.video) ? 'copy' : 'h264';
  const directOk = (n) => n === browserDefault && containerOk(info) && vmode === 'copy' && audioCodecOk((audios[n] || {}).codec);
  const cur = () => offset + (v.currentTime || 0);
  const dur = () => (mode === 'remux' ? info.duration : (isFinite(v.duration) && v.duration ? v.duration : info.duration)) || 0;
  // Los subtítulos se desplazan para que sigan sincronizados en modo pista
  const shiftSubs = () => {
    for (const tr of v.textTracks) {
      if (!tr.cues) continue;
      for (const c of tr.cues) {
        if (c._s == null) { c._s = c.startTime; c._e = c.endTime; }
        c.startTime = c._s - offset; c.endTime = c._e - offset;
      }
    }
  };
  for (const el of $$('track', v)) el.addEventListener('load', shiftSubs);
  const setAudio = (n, at = cur()) => {
    const playing = !(v.paused && v.currentTime > 0); // si estaba en pausa a propósito, sigue en pausa
    if (directOk(n) || !canRemux()) {
      mode = 'direct'; offset = 0; audioN = null;
      v.src = '/stream/' + fileId;
      v.addEventListener('loadedmetadata', () => { v.currentTime = at; shiftSubs(); }, { once: true });
    } else {
      // El vídeo solo puede empezar en un fotograma clave: se pregunta cuál es y se ajusta el tiempo
      mode = 'remux'; audioN = n;
      const want = Math.max(0, at), token = ++seekToken;
      $('#spin').hidden = false;
      api(`/api/seek/${fileId}?t=${want.toFixed(2)}`).catch(() => ({ start: want })).then(({ start }) => {
        if (token !== seekToken) return;
        offset = start;
        v.src = `/stream/${fileId}/audio/${n}?t=${start.toFixed(3)}${vmode === 'h264' ? '&v=h264' : ''}`;
        shiftSubs();
        // Avanza hasta el segundo pedido en cuanto haya datos
        const gap = want - start;
        if (gap > 0.4) {
          const jump = () => {
            if (token !== seekToken) return v.removeEventListener('progress', jump);
            const b = v.buffered; if (b.length && b.end(b.length - 1) > gap + 0.5) { v.currentTime = gap; v.removeEventListener('progress', jump); }
          };
          v.addEventListener('progress', jump);
        }
        if (playing) v.play().catch(() => {});
      });
      return;
    }
    $('#spin').hidden = false;
    if (playing) v.play().catch(() => {});
  };
  const seekTo = (sec) => {
    const d = dur();
    sec = Math.max(0, d ? Math.min(d - 1, sec) : sec);
    if (mode === 'remux') setAudio(audioN, sec); else v.currentTime = sec;
  };
  const currentAudio = () => {
    if (canNativeSwitch()) { for (let i = 0; i < v.audioTracks.length; i++) if (v.audioTracks[i].enabled) return i; return 0; }
    return mode === 'remux' ? audioN : browserDefault;
  };

  const save = (keepalive) => {
    if (!dur()) return;
    lastSave = Date.now();
    api('/api/progress', { method: 'POST', body: { fileId, t: cur(), d: dur() }, keepalive }).catch(() => {});
  };
  const wake = () => {
    player.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (!v.paused && !$('.menu', player)) { player.classList.add('idle'); } }, 3500);
  };
  const seekBy = (s) => { if (dur()) seekTo(cur() + s); wake(); };
  const toggle = () => { v.paused ? v.play() : v.pause(); wake(); };
  const leave = () => { save(true); if (state.depth > 0) history.back(); else go('/t/' + info.titleId); };
  const playNext = () => { save(true); location.replace('#/ver/' + info.next.fileId); };

  // Subtítulos: por defecto activa español si existe
  const setSub = (idx) => { [...v.textTracks].forEach((tr, i) => { tr.mode = i === idx ? 'showing' : 'disabled'; }); setTimeout(() => shiftSubs(), 300); try { localStorage.setItem('subLang', idx >= 0 ? info.subs[idx].lang : 'off'); } catch {} };
  v.addEventListener('loadedmetadata', () => {
    let pref = 'es'; try { pref = localStorage.getItem('subLang') || 'es'; } catch {}
    setSub(pref === 'off' ? -1 : (info.subs || []).findIndex((s) => s.lang === pref));
    const p = info.progress;
    const startAt = resumeAt(p);
    if (startAt) toast('Reanudando desde ' + fmtTime(p.t));
    // Audio en castellano: Safari cambia la pista; en Chrome/Firefox se usa el "modo pista"
    const wantN = info.prefAudio != null ? info.prefAudio : 0;
    if (selectAudio(v, info) && directOk(browserDefault)) { if (startAt) v.currentTime = startAt; }
    else if (canRemux() && !directOk(wantN)) setAudio(wantN, startAt);
    else if (startAt) v.currentTime = startAt;
  }, { once: true });

  v.addEventListener('timeupdate', () => {
    const d = dur(), pct = d ? (cur() / d) * 100 : 0;
    $('#fill').style.width = pct + '%'; $('#knob').style.left = pct + '%';
    $('#time').textContent = fmtTime(cur()) + ' / ' + fmtTime(d);
    if (v.buffered.length && d) $('#buf').style.width = Math.min(100, (offset + v.buffered.end(v.buffered.length - 1)) / d * 100) + '%';
    if (Date.now() - lastSave > 10000) save();
  });
  v.addEventListener('play', () => { $('#p-play').innerHTML = ICON.pause; $('#p-center').innerHTML = ICON.pause; wake(); });
  v.addEventListener('pause', () => { $('#p-play').innerHTML = ICON.play; $('#p-center').innerHTML = ICON.play; player.classList.remove('idle'); save(); });
  v.addEventListener('waiting', () => { $('#spin').hidden = false; });
  v.addEventListener('playing', () => { $('#spin').hidden = true; });
  v.addEventListener('canplay', () => { $('#spin').hidden = true; });
  const toCompat = (why) => {
    if (!canRemux() || compatTried >= 2) return false;
    compatTried++;
    if (mode === 'remux' || why === 'sin-imagen') vmode = 'h264';
    const n = mode === 'remux' ? audioN : (info.prefAudio != null ? info.prefAudio : 0);
    toast(vmode === 'h264' ? 'Adaptando el vídeo a este aparato…' : 'Adaptando el formato…');
    setAudio(n, Math.max(0, cur()));
    return true;
  };
  let compatTried = 0;
  v.addEventListener('error', () => {
    $('#spin').hidden = true;
    if (toCompat('error')) return;
    toast('No se pudo reproducir el vídeo en este aparato.');
  });
  // Suena pero no se ve (p. ej. HEVC sin soporte): se convierte la imagen
  v.addEventListener('playing', () => {
    setTimeout(() => { if (!v.paused && v.videoWidth === 0 && media.video) toCompat('sin-imagen'); }, 1500);
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
  $('#p-restart').onclick = () => { seekTo(0); toast('Desde el principio'); wake(); };
  if (info.next) $('#p-next').onclick = playNext;
  if ($('#p-full')) $('#p-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : player.requestFullscreen?.());
  if ($('#p-audio')) {
    if (!canRemux() && !('audioTracks' in v)) $('#p-audio').hidden = true; // sin forma de cambiarla en este navegador
    $('#p-audio').onclick = () => {
      if ($('.menu', player)) return $('.menu', player).remove();
      const active = currentAudio();
      const m = document.createElement('div'); m.className = 'menu';
      m.innerHTML = '<div class="menu-title">Audio</div>' + audios.map((a, i) => `<button class="focusable${active === i ? ' on' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('');
      m.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        const n = +b.dataset.i;
        if (canNativeSwitch()) { for (let i = 0; i < v.audioTracks.length; i++) v.audioTracks[i].enabled = i === n; }
        else if (n !== currentAudio()) setAudio(n);
        m.remove(); focusEl($('#p-audio')); toast('Audio: ' + audios[n].label);
      };
      $('.ui', player).appendChild(m); focusEl($('button.on', m) || $('button', m));
    };
  }
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
    if (dur()) $('#time').textContent = fmtTime(pct * dur()) + ' / ' + fmtTime(dur());
  };
  seek.addEventListener('pointerdown', (e) => { dragging = true; seek.setPointerCapture(e.pointerId); preview(seekPct(e)); wake(); e.preventDefault(); });
  seek.addEventListener('pointermove', (e) => { if (dragging) { preview(seekPct(e)); wake(); } });
  const endDrag = (e) => { if (!dragging) return; dragging = false; if (dur()) seekTo(seekPct(e) * dur()); wake(); };
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
    try { window.NubeTV && window.NubeTV.fullscreen && window.NubeTV.fullscreen(false); } catch {}
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
async function renderAccount() {
  app.innerHTML = `<div class="page" style="max-width:620px"><h1>Mi cuenta</h1>
    <div class="panel"><h3>${esc(state.me.username)}</h3><p>${state.me.admin ? 'Administrador' : 'Usuario'}</p>
      <div class="actions"><button class="btn focusable" id="logout">Cerrar sesión</button>
      ${window.NubeTV ? '<button class="btn ghost focusable" id="server">Cambiar servidor</button>' : ''}</div></div>
    <div class="panel"><h3>Dispositivos conectados</h3><p>Si ves alguno que no reconoces, cierra sesión en todos y cambia la contraseña.</p>
      <div id="devices" class="small-list">Cargando…</div>
      <button class="btn small focusable" id="logout-others" style="margin-top:12px">Cerrar sesión en los demás</button></div>
    <div class="panel" id="tfa"><h3>Verificación en dos pasos</h3><div id="tfa-body"></div></div>
    <form class="panel" id="pw"><h3>Cambiar contraseña</h3>
      <div class="field"><label>Contraseña actual</label><input class="input focusable" type="password" name="current" autocomplete="current-password" required></div>
      <div class="field"><label>Nueva contraseña</label><input class="input focusable" type="password" name="next" autocomplete="new-password" minlength="8" required><div class="hint">Mínimo 8 caracteres. Se cerrará la sesión en tus otros dispositivos.</div></div>
      <div class="error" id="err"></div><button class="btn primary focusable">Guardar</button></form></div>`;
  $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); state.me = null; state.sections = null; stopLive(); go('/login'); };
  if ($('#server')) $('#server').onclick = () => window.NubeTV.changeServer();
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); $('#err').textContent = ''; toast('Contraseña cambiada'); loadDevices(); }
    catch (err) { $('#err').textContent = err.message; }
  };
  const loadDevices = async () => {
    const list = await api('/api/sessions');
    $('#devices').innerHTML = list.map((d) => `<div class="row-item"><b>${esc(d.device)}</b>${d.current ? ' <span class="tag">este</span>' : ''}
      <span class="muted"> · ${esc(d.ip)} · ${d.last ? new Date(d.last).toLocaleString('es-ES') : ''}</span></div>`).join('');
  };
  $('#logout-others').onclick = async () => { const r = await api('/api/sessions/logout-others', { method: 'POST' }); toast(`Sesión cerrada en ${r.closed} dispositivo(s)`); loadDevices(); };
  loadDevices();
  // 2FA
  const drawTfa = () => {
    const b = $('#tfa-body');
    if (state.me.twoFactor) {
      b.innerHTML = `<p>✅ <b>Activada.</b> Al entrar te pediremos un código de tu app de autenticación.</p>
        <form id="tfa-off"><div class="two"><div class="field"><label>Contraseña</label><input class="input focusable" type="password" name="password" required></div>
        <div class="field"><label>Código actual</label><input class="input focusable" name="code" inputmode="numeric" maxlength="6" required></div></div>
        <div class="error" id="tfa-err"></div><button class="btn small danger focusable">Desactivar</button></form>`;
      $('#tfa-off').onsubmit = async (e) => {
        e.preventDefault();
        try { await api('/api/2fa/disable', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); state.me.twoFactor = false; toast('Verificación en dos pasos desactivada'); drawTfa(); }
        catch (err) { $('#tfa-err').textContent = err.message; }
      };
    } else {
      b.innerHTML = `<p>Protege tu cuenta: además de la contraseña, al entrar se pedirá un código que cambia cada 30 segundos en tu móvil
        (Google Authenticator, Microsoft Authenticator, Authy…).${state.me.admin ? ' <b>Muy recomendable para la cuenta de administrador.</b>' : ''}</p>
        <button class="btn primary small focusable" id="tfa-start">Activar</button>`;
      $('#tfa-start').onclick = async () => {
        const r = await api('/api/2fa/setup', { method: 'POST' });
        b.innerHTML = `<p><b>1.</b> En tu móvil, abre tu app de autenticación y añade una cuenta con esta clave
          (o <a href="${esc(r.url)}" style="color:var(--accent)">toca aquí</a> si estás en el móvil):</p>
          <p class="code" style="font-size:17px;letter-spacing:.08em;word-break:break-all;display:inline-block;padding:8px 12px">${esc(r.secret.replace(/(.{4})/g, '$1 ').trim())}</p>
          <form id="tfa-on"><p><b>2.</b> Escribe el código de 6 cifras que aparece en la app:</p>
          <div class="field" style="max-width:200px"><input class="input focusable" name="code" inputmode="numeric" maxlength="6" required></div>
          <div class="error" id="tfa-err"></div><button class="btn primary small focusable">Confirmar y activar</button></form>`;
        $('#tfa-on').onsubmit = async (e) => {
          e.preventDefault();
          try { await api('/api/2fa/enable', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); state.me.twoFactor = true; toast('Verificación en dos pasos activada'); drawTfa(); }
          catch (err) { $('#tfa-err').textContent = err.message; }
        };
      };
    }
  };
  drawTfa();
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
    const [users, settings, accesses] = await Promise.all([api('/api/admin/users'), api('/api/admin/settings'), api('/api/admin/access-log')]);
    const pending = users.filter((u) => !u.approved);
    body.innerHTML = `${pending.length ? `<div class="panel" style="border-color:var(--accent)"><h3>Pendientes de aprobación (${pending.length})</h3><p>Estas personas se han registrado y no pueden ver nada hasta que las aceptes.</p>
      ${pending.map((u) => `<div class="row-item"><b>${esc(u.username)}</b> <span class="muted">· ${new Date(u.createdAt).toLocaleString('es-ES')}</span>
        <span style="float:right"><button class="btn small primary focusable" data-approve="${u.id}">Aprobar</button>
        <button class="btn small danger focusable" data-del="${u.id}" data-name="${esc(u.username)}">Rechazar</button></span></div>`).join('')}</div>` : ''}
      <div class="panel"><h3>${(settings.allowedUsers || []).length ? 'Web privada' : 'Invitar a alguien'}</h3><p>${(settings.allowedUsers || []).length ? `Solo pueden entrar: <b>${settings.allowedUsers.map(esc).join(', ')}</b>. Nadie más puede crear cuenta ni ver el contenido. Se cambia en Ajustes.` : settings.requireInvite ? `Comparte el enlace de la web y este código para que se registren: <span class="code">${esc(settings.inviteCode)}</span> (puedes cambiarlo en Ajustes).` : 'El registro está abierto: cualquiera con el enlace de la web puede crear una cuenta. Puedes exigir un código en Ajustes.'}</p></div>
      <div class="panel"><h3>Usuarios (${users.length - pending.length})</h3><div style="overflow-x:auto"><table class="table"><thead><tr><th>Usuario</th><th>Rol</th><th>Último acceso</th><th>Disp.</th><th></th></tr></thead><tbody>
      ${users.filter((u) => u.approved).map((u) => `<tr><td><b>${esc(u.username)}</b>${u.id === state.me.id ? ' (tú)' : ''}${u.twoFactor ? ' 🔒' : ''}</td><td>${u.admin ? 'Admin' : 'Usuario'}</td>
        <td>${u.lastLogin ? new Date(u.lastLogin.at).toLocaleString('es-ES') + `<br><span class="muted">${esc(u.lastLogin.ip)}</span>` : '—'}</td><td>${u.devices}</td>
        <td style="white-space:nowrap">${u.id === state.me.id ? '' : `${settings.adminFixed ? '' : `<button class="btn small focusable" data-role="${u.id}" data-admin="${u.admin ? 0 : 1}">${u.admin ? 'Quitar admin' : 'Hacer admin'}</button>`}
        <button class="btn small focusable" data-pass="${u.id}">Nueva contraseña</button>
        <button class="btn small focusable" data-kick="${u.id}">Cerrar sesiones</button>
        <button class="btn small danger focusable" data-del="${u.id}" data-name="${esc(u.username)}">Borrar</button>`}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="panel"><h3>Accesos recientes</h3><p>Inicios de sesión, intentos fallidos y registros. 🌍 = desde fuera de España (normalmente bloqueado).</p>
      <div style="overflow-x:auto;max-height:420px;overflow-y:auto"><table class="table"><thead><tr><th>Fecha</th><th>Usuario</th><th>Resultado</th><th>IP</th><th>Dispositivo</th></tr></thead><tbody>
      ${accesses.map((a) => `<tr${a.result === 'correcto' || a.result.startsWith('registro') ? '' : ' style="color:var(--danger)"'}><td style="white-space:nowrap">${new Date(a.at).toLocaleString('es-ES')}</td>
        <td>${esc(a.user)}</td><td>${esc(a.result)}</td><td>${esc(a.ip)}${a.place === 'fuera de España' ? ' 🌍' : ''}</td><td>${esc(a.device || '')}</td></tr>`).join('') || '<tr><td colspan="5">Sin registros todavía.</td></tr>'}
      </tbody></table></div></div>`;
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.approve) { await api('/api/admin/users/' + b.dataset.approve, { method: 'POST', body: { approved: true } }); toast('Cuenta aprobada'); renderAdmin('usuarios'); }
        if (b.dataset.kick) { await api('/api/admin/users/' + b.dataset.kick, { method: 'POST', body: { logout: true } }); toast('Sesiones cerradas'); renderAdmin('usuarios'); }
        if (b.dataset.role) { await api('/api/admin/users/' + b.dataset.role, { method: 'POST', body: { admin: b.dataset.admin === '1' } }); renderAdmin('usuarios'); }
        if (b.dataset.del && await confirmDialog(`¿Borrar la cuenta de ${b.dataset.name}?`, 'Borrar')) { await api('/api/admin/users/' + b.dataset.del, { method: 'DELETE' }); toast('Usuario borrado'); renderAdmin('usuarios'); }
        if (b.dataset.pass) {
          const d = dialog(`<h3>Nueva contraseña</h3><form><div class="field"><input class="input focusable" name="password" type="text" minlength="8" required></div>
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
        <div class="field"><label>Usuarios con acceso (web privada)</label><input class="input focusable" name="allowedUsers" value="${esc((s.allowedUsers || []).join(', '))}" ${s.allowedFromEnv ? 'disabled' : ''} placeholder="Vacío = cualquiera con cuenta">
          <small style="color:var(--muted)">Solo estos usuarios pueden entrar y ver el contenido, separados por comas. Nadie más puede crear cuenta.${s.allowedFromEnv ? ' (Fijado en el archivo .env del servidor)' : ''}</small></div>
        <label style="display:flex;gap:8px;align-items:center;margin:4px 0 8px"><input type="checkbox" class="focusable" name="requireApproval" ${s.requireApproval ? 'checked' : ''}> Aprobar a mano las cuentas nuevas</label>
        <label style="display:flex;gap:8px;align-items:center;margin:4px 0 12px"><input type="checkbox" class="focusable" name="requireInvite" ${s.requireInvite ? 'checked' : ''}> Pedir código de invitación para registrarse</label>
        <div class="field"><label>Código de invitación</label><input class="input focusable" name="inviteCode" value="${esc(s.inviteCode)}"></div>
        <button class="btn primary focusable">Guardar</button></form>
      ${s.security ? `<div class="panel" style="max-width:560px"><h3>Seguridad</h3><p>
        Acceso permitido desde: <b>${s.security.countries.length ? esc(s.security.countries.join(', ')) : 'todo el mundo'}</b><br>
        ${s.security.countries.length ? (s.security.geo.loaded ? `Base de datos de países: ${s.security.geo.ranges} rangos de IP · actualizada ${new Date(s.security.geo.updated).toLocaleDateString('es-ES')}` : '⚠️ La base de datos de países aún no se ha descargado: de momento no se bloquea a nadie.') + '<br>' : ''}
        Visitas bloqueadas por país: ${s.security.geoBlocked} · por exceso de peticiones: ${s.security.rateLimited} · IPs bloqueadas por rastreo: ${s.security.banned}<br>
        Tu conexión: <span class="code">${esc(s.security.myIp)}</span> (${esc(s.security.myIpStatus)})${s.security.myIpStatus === 'red local' ? ' ⚠️ el servidor no ve tu IP real: la restricción por país no te afecta a ti, pero podría no funcionar para nadie' : ''}<br>
        La web no aparece en buscadores (Google, Bing…).</p></div>` : ''}
      <div class="panel" style="max-width:560px"><h3>Nube</h3><p>Modo: <b>${s.storage === 'local' ? 'carpeta local' : 'rclone'}</b><br>
        Carpeta: <span class="code">${esc(s.remote)}${esc(s.libraryPath)}</span><br>
        Carátulas automáticas (TMDB): ${s.tmdb ? 'activadas' : 'desactivadas'}<br><br>Estos valores se cambian en <span class="code">config.json</span> del servidor.</p></div>`;
    $('#sf').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target)); body.requireInvite = !!body.requireInvite; body.requireApproval = !!body.requireApproval;
      try { await api('/api/admin/settings', { method: 'PUT', body }); toast('Ajustes guardados'); loadConfig(); }
      catch (err) { toast(err.message); }
    };
  }
  autofocus('.tabs .chip.on');
}

// ---------------- Arranque ----------------
// La cabecera es fija: el contenido empieza justo debajo, aunque el menú ocupe dos líneas
(() => {
  const top = $('#topbar');
  const setH = () => document.documentElement.style.setProperty('--topbar-h', top.offsetHeight + 'px');
  if (window.ResizeObserver) new ResizeObserver(setH).observe(top); else window.addEventListener('resize', setH);
  setH();
})();
async function loadConfig() {
  try {
    const c = await api('/api/config', { allow401: true });
    state.siteName = c.siteName; state.requireInvite = !!c.requireInvite; document.title = c.siteName; $('#brand-name').textContent = c.siteName;
  } catch {}
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
loadConfig().then(render);
})();
