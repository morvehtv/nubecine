'use strict';
// Analiza las pistas de audio de cada vídeo con ffprobe (solo lee la cabecera del archivo)
// y elige la pista en español de España (castellano).
const { execFile } = require('child_process');

const LATINO = /latino|latam|latinoam|hispanoam|m[eé]xic|\b419\b|es[-_](419|mx|ar|co|cl|pe|us)\b|\blat\b/i;
const CASTELLANO = /castellano|espa[nñ]a|spain|\bes[-_]es\b|\bcast\b|\bspa(nish)?\s*\(es\)/i;
const ES_LANG = /^(es|spa|esp)([-_][a-z0-9]+)?$/i;

const LANG_NAMES = { spa: 'Español', es: 'Español', eng: 'Inglés', en: 'Inglés', fre: 'Francés', fra: 'Francés', fr: 'Francés', ita: 'Italiano', it: 'Italiano', ger: 'Alemán', deu: 'Alemán', de: 'Alemán', por: 'Portugués', pt: 'Portugués', jpn: 'Japonés', ja: 'Japonés', kor: 'Coreano', ko: 'Coreano', cat: 'Catalán', ca: 'Catalán', chi: 'Chino', zho: 'Chino', rus: 'Ruso', ru: 'Ruso' };

// Nombre que se muestra al usuario para una pista
function audioLabel(a) {
  const txt = `${a.lang || ''} ${a.title || ''}`;
  const isEs = ES_LANG.test(a.lang || '') || /espa[nñ]ol|castellano|latino|spanish/i.test(a.title || '');
  if (isEs && LATINO.test(txt)) return 'Español (Latino)';
  if (isEs) return 'Castellano';
  return LANG_NAMES[(a.lang || '').toLowerCase()] || a.title || (a.lang ? a.lang.toUpperCase() : 'Desconocido');
}

// Puntuación: cuanto más alta, más probable que sea castellano
function score(a) {
  const txt = `${a.lang || ''} ${a.title || ''}`;
  const isEs = ES_LANG.test(a.lang || '') || /espa[nñ]ol|castellano|spanish/i.test(a.title || '');
  if (!isEs && !CASTELLANO.test(txt)) return 0;
  if (LATINO.test(txt)) return 10;          // español, pero latino: solo si no hay otro
  if (CASTELLANO.test(txt)) return 100;     // marcado expresamente como castellano
  return 50;                                // español sin más detalle
}

// Devuelve el número de orden (0, 1, 2…) de la pista de audio preferida, o null
function pickCastellano(audio) {
  let best = null, bestScore = 0;
  audio.forEach((a, i) => { const s = score(a); if (s > bestScore) { bestScore = s; best = i; } });
  return best;
}

function ffprobe(url, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-rw_timeout', '30000000',
      '-show_entries', 'format=duration,format_name:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,channels,disposition:stream_tags=language,title,handler_name:stream_disposition=default,attached_pic',
      '-of', 'json', url], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const json = JSON.parse(stdout);
        const streams = json.streams || [];
        const tagTitle = (s) => (s.tags && (s.tags.title || (/^(sound|audio|video)handler$|core media|iso media|^$/i.test((s.tags.handler_name || '').trim()) ? '' : s.tags.handler_name.trim()))) || '';
        const audio = streams.filter((s) => s.codec_type === 'audio').map((s) => ({
          lang: (s.tags && s.tags.language) || '',
          // En MP4 el nombre de la pista suele ir en handler_name (se ignoran los genéricos)
          title: tagTitle(s),
          codec: s.codec_name || '',
          channels: s.channels || 0,
          default: !!(s.disposition && s.disposition.default),
        }));
        // Primera pista de vídeo real (no la carátula incrustada)
        const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        const video = v ? { codec: v.codec_name || '', profile: v.profile || '', pixFmt: v.pix_fmt || '', width: v.width || 0, height: v.height || 0 } : null;
        resolve({ audio, video, duration: parseFloat((json.format || {}).duration) || 0, container: (json.format || {}).format_name || '' });
      } catch (e) { reject(e); }
    });
  });
}

let available = null;
function ffprobeAvailable() {
  if (available !== null) return Promise.resolve(available);
  return new Promise((resolve) => execFile('ffprobe', ['-version'], (err) => resolve(available = !err)));
}

module.exports = { ffprobe, ffprobeAvailable, pickCastellano, audioLabel };
