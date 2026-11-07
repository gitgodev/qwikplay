// Qwik — hybrid streaming player with Up Next queue.
// - BandLab (engine:'audio'): direct <audio> streaming of public mixdown .m4a
// - SoundCloud (engine:'soundcloud'): official hidden Widget, custom skin drives it
// - Queue persisted to localStorage. No <a download> anywhere (deterrence, not DRM).

const $ = (s) => document.querySelector(s);
const audio = $('#audio');
const video = $('#video');
const scFrame = $('#scFrame');
const trackListEl = $('#trackList');
const queueListEl = $('#queueList');
const playBtn = $('#playBtn');
const prevBtn = $('#prevBtn');
const nextBtn = $('#nextBtn');
const seekEl = $('#seek');
const volEl = $('#vol');
const searchEl = $('#search');
const sourceFilterEl = $('#sourceFilter');
const countEl = $('#count');
const pbTitle = $('#pbTitle');
const pbTime = $('#pbTime');
const pbArt = $('#pbArt');
const nowTitle = $('#nowTitle');
const nowArtist = $('#nowArtist');
const wave = $('#wave');
const queuePanel = $('#queuePanel');
const repeatBtn = $('#repeatBtn');
const toast = $('#toast');

// Private admin (dev) mode: curate tracks. Activated via ?admin=1 / #admin=1,
// a discreet corner toggle, or a persisted choice — so it keeps working on
// hosts (like GitHub Pages) where query strings can be dropped/normalized.
const ADMIN_HASH = (typeof window !== 'undefined' && window.QWIK_ADMIN_HASH ? String(window.QWIK_ADMIN_HASH).trim() : '');
let ADMIN = false;
function readAdminParam() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('admin')) return q.get('admin') !== '0' && q.get('admin') !== 'false';
    const h = (location.hash || '').replace(/^#/, '');
    if (h) {
      const hp = new URLSearchParams(h.includes('=') ? h : 'admin=' + h);
      if (hp.has('admin')) return hp.get('admin') !== '0' && hp.get('admin') !== 'false';
    }
  } catch {}
  return null;
}
// When an admin password hash is configured (via env at deploy time), URL params
// and stale localStorage flags cannot bypass it. Admin state is kept in
// sessionStorage only, so a password is required on a fresh browser/session.
if (!ADMIN_HASH) {
  const _adminParam = readAdminParam();
  if (_adminParam !== null) {
    ADMIN = _adminParam;
    try { localStorage.setItem('adminMode', ADMIN ? '1' : '0'); } catch {}
  } else {
    try { ADMIN = localStorage.getItem('adminMode') === '1'; } catch { ADMIN = false; }
  }
} else {
  // Drop any legacy persisted admin flag so it can't bypass the password.
  try { localStorage.removeItem('adminMode'); } catch {}
  try { ADMIN = sessionStorage.getItem('adminSession') === '1'; } catch { ADMIN = false; }
}
async function adminPasswordOk(pw) {
  if (!ADMIN_HASH || !pw) return false;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex === ADMIN_HASH.toLowerCase();
  } catch { return false; }
}
// Local visibility overrides (id -> true = hidden). Export writes them to songs.json.
let localVis = {};
try { localVis = JSON.parse(localStorage.getItem('visOverrides') || '{}'); } catch { localVis = {}; }
function isHidden(s) { return localVis[s.id] ?? (s.visible === false); }
function visibleSongs() { return SONGS.filter((s) => !isHidden(s)); }

let SONGS = [];
let baseSongs = [];
let QUEUE = [];
let currentId = null;
let isSeeking = false;
let activeEngine = 'audio'; // 'audio' | 'soundcloud'
let useVideo = false;
let repeatMode = 0; // 0=off, 1=all, 2=one
let playCounts = {};
try { playCounts = JSON.parse(localStorage.getItem('playCounts') || '{}'); } catch { playCounts = {}; }
let toastTimer = null;

// --- SoundCloud widget state ---
let scWidget = null;
let scPlaying = false;
let scPos = 0;
let scDur = 0;
let scTimer = null;

function scInit() {
  if (scWidget || !window.SC) return;
  try {
    scWidget = window.SC.Widget(scFrame);
  } catch { scWidget = null; return; }
  try {
    scWidget.bind(window.SC.Widget.Events.PLAY, () => { scPlaying = true; updatePlayBtn(); });
    scWidget.bind(window.SC.Widget.Events.PAUSE, () => { scPlaying = false; updatePlayBtn(); });
    scWidget.bind(window.SC.Widget.Events.FINISH, () => step(1));
    scWidget.bind(window.SC.Widget.Events.PLAY_PROGRESS, (e) => {
      scPos = e.currentPosition; scDur = e.relativePosition ? scPos / e.relativePosition : scDur;
      if (activeEngine === 'soundcloud' && !isSeeking && scDur) paintProgress(scPos / 1000, scDur / 1000);
    });
  } catch { /* widget not ready yet; events rebind on next load */ }
}
function scPollStart() {
  clearInterval(scTimer);
  scTimer = setInterval(() => {
    if (activeEngine !== 'soundcloud' || !scWidget) return;
    try {
      scWidget.getPosition((p) => {
        scPos = p;
        scWidget.getDuration((d) => {
          scDur = d;
          if (!isSeeking && d) paintProgress(p / 1000, d / 1000);
        });
      });
    } catch {}
  }, 500);
}

try {
  QUEUE = JSON.parse(localStorage.getItem('upnext') || '[]');
  currentId = localStorage.getItem('currentId') || null;
} catch { QUEUE = []; }

function save() {
  localStorage.setItem('upnext', JSON.stringify(QUEUE));
  localStorage.setItem('playCounts', JSON.stringify(playCounts));
  if (currentId) localStorage.setItem('currentId', currentId);
}
function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}
function fmt(s) {
  if (!isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function songById(id) { return SONGS.find((s) => s.id === id); }
function isPlaying() { return activeEngine === 'soundcloud' ? scPlaying : useVideo ? !video.paused : !audio.paused; }
// Default cover: gradient disc + first letter, used when a CDN image fails or is a placeholder.
window.__artFallback = (t) => {
  const ch = ((t || '?').trim().charAt(0) || '?').toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='500' height='500'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#7df0c6'/><stop offset='1' stop-color='#8ab4ff'/></linearGradient></defs><rect width='500' height='500' fill='#141821'/><circle cx='250' cy='215' r='105' fill='url(#g)' opacity='0.9'/><text x='250' y='253' font-size='110' text-anchor='middle' fill='#0b0d12' font-family='sans-serif' font-weight='bold'>${ch.replace(/[<>&]/g, '')}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};
function isVideoUrl(url) {
  if (!url) return false;
  return /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url);
}
function isBadArt(url) {
  if (!url) return true;
  return url.includes('fb_placeholder') || url.includes('placeholder') || url.includes('default');
}
function defaultArtwork() { try { return localStorage.getItem('defaultArtwork') || ''; } catch { return ''; } }
function bannerImage() { try { return localStorage.getItem('bannerImage') || ''; } catch { return ''; } }
function applyBanner() {
  const disc = document.querySelector('.disc');
  if (!disc) return;
  const url = bannerImage();
  if (url) {
    disc.style.background = `url(${url}) center/cover no-repeat`;
    disc.style.border = '2px solid var(--line)';
  } else {
    disc.style.background = '';
    disc.style.border = '';
  }
}
function currentTheme() { try { return localStorage.getItem('theme') || 'dark'; } catch { return 'dark'; } }
function applyTheme() {
  const t = currentTheme();
  document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
  const btn = $('#themeToggle');
  if (btn) btn.textContent = t === 'light' ? '☀️' : '🌙';
}
function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('theme', next); } catch {}
  applyTheme();
}
function currentView() { try { return localStorage.getItem('viewMode') || 'grid'; } catch { return 'grid'; } }
function applyView() {
  const v = currentView();
  const tl = $('#trackList');
  if (tl) tl.classList.toggle('list-view', v === 'list');
  const btn = $('#viewToggle');
  if (btn) btn.textContent = v === 'list' ? '⊞ Grid' : '☰ List';
}
function updateTotalPlays() {
  const el = $('#totalPlays');
  if (!el) return;
  const platformTotal = SONGS.reduce((a, s) => a + (Number(s.plays) || 0), 0);
  const localTotal = Object.values(playCounts || {}).reduce((a, n) => a + (Number(n) || 0), 0);
  const total = platformTotal + localTotal;
  el.textContent = `Total plays: ${total.toLocaleString()}`;
}
function toggleView() {
  const next = currentView() === 'list' ? 'grid' : 'list';
  try { localStorage.setItem('viewMode', next); } catch {}
  applyView();
}
function artFor(s, fallbackEmoji = '♪') {
  const art = (s?.artwork && !isBadArt(s.artwork)) ? s.artwork : (defaultArtwork() || '');
  if (art) {
    return `<img src="${art}" alt="${escapeHtml(s?.title || 'cover')}" loading="lazy" draggable="false" referrerpolicy="no-referrer" data-t="${escapeHtml(s?.title || '?')}" onerror="this.onerror=null;this.src=window.__artFallback(this.dataset.t)" />`;
  }
  if (s?.artwork) return `<img src="${window.__artFallback(s?.title)}" alt="${escapeHtml(s?.title || 'cover')}" draggable="false" />`;
  return fallbackEmoji;
}
function peaksFor(id, n = 96) {
  let h = 2166136261;
  for (const c of String(id)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const out = [];
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ (h >>> 13), 16777619);
    const v = ((h >>> 0) % 1000) / 1000;
    const env = 0.35 + 0.65 * Math.abs(Math.sin(i / 9));
    out.push(0.12 + v * 0.88 * env);
  }
  return out;
}
function drawWave(progress = 0) {
  const ctx = wave.getContext('2d');
  const W = wave.width, H = wave.height;
  ctx.clearRect(0, 0, W, H);
  const peaks = peaksFor(currentId || 'idle', 96);
  const bw = W / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const ph = peaks[i] * (H - 12);
    const x = i * bw + bw * 0.2;
    ctx.fillStyle = i / peaks.length <= progress ? '#7df0c6' : 'rgba(255,255,255,.22)';
    ctx.fillRect(x, (H - ph) / 2, Math.max(1.5, bw * 0.6), ph);
  }
}
function paintProgress(cur, dur) {
  if (!dur) return;
  seekEl.value = Math.round((cur / dur) * 1000);
  pbTime.textContent = `${fmt(cur)} / ${fmt(dur)}`;
  drawWave(cur / dur);
}

function renderTracks() {
  const q = searchEl.value.trim().toLowerCase();
  const src = sourceFilterEl.value;
  const pool = ADMIN ? SONGS : visibleSongs();
  const filtered = pool.filter((s) => {
    const okQ = !q || `${s.title} ${s.artist}`.toLowerCase().includes(q);
    const okS = src === 'all' || s.source === src;
    return okQ && okS;
  });
  const sortMode = (sortSelect && sortSelect.value) || 'manual';
  const list = [...filtered].sort((a, b) => {
    if (sortMode === 'plays') return (b.plays || 0) - (a.plays || 0);
    if (sortMode === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
    return 0; // manual: keep stored order
  });
  const hiddenN = SONGS.length - visibleSongs().length;
  countEl.textContent = `${list.length} track${list.length === 1 ? '' : 's'}`;
  trackListEl.innerHTML = list.map((s) => {
    const hidden = isHidden(s);
    const isCurrent = s.id === currentId;
    const eqBars = isCurrent && isPlaying() ? '<div class="eq-bars"><span></span><span></span><span></span><span></span></div>' : '';
    const adminControls = ADMIN ? `
      <div class="admin-controls">
        <input type="checkbox" class="admin-check" data-id="${s.id}" title="Select for bulk actions" />
        <button data-act="${hidden ? 'show' : 'hide'}" class="ghost">${hidden ? '👁 Show' : '🚫 Hide'}</button>
        <button data-act="edit" class="ghost">✏ Edit</button>
        <button data-act="moveUp" class="ghost" title="Move up">↑</button>
        <button data-act="moveDown" class="ghost" title="Move down">↓</button>
      </div>` : '';
    return `
    <div class="track ${isCurrent ? 'active' : ''} ${hidden ? 'is-hidden' : ''}" data-id="${s.id}">
      <div class="art" ${hidden ? '' : 'data-act="play" style="cursor:pointer" title="Play"'}>${artFor(s)}</div>
      <div>
        <div class="t">${escapeHtml(s.title)}<span class="badge">${escapeHtml(s.source)}</span>${hidden ? '<span class="badge hidden-badge">hidden</span>' : ''}</div>
        <div class="a">${escapeHtml(s.artist || '')}${s.durationSec ? ` · ${fmt(s.durationSec)}` : ''}${s.plays ? ` · ${s.plays} plays` : ''}</div>
        <div class="row">
          ${hidden ? '' : '<button data-act="play">Play</button>'}
          ${hidden ? '' : '<button data-act="next" class="ghost">Play next</button>'}
          ${hidden ? '' : '<button data-act="add" class="ghost">+ Up Next</button>'}
          ${s.sourceUrl ? `<a class="src" href="${s.sourceUrl}" target="_blank" rel="noopener">Open original ↗</a>` : ''}
          ${s.altSourceUrl ? `<a class="src" href="${s.altSourceUrl}" target="_blank" rel="noopener">Also on ${escapeHtml(s.altSource)} ↗</a>` : ''}
        </div>
        ${adminControls}
      </div>
      ${eqBars}
    </div>`;
  }).join('') || `<div class="empty">No tracks match your search. <button id="clearSearch" class="ghost">Clear filters</button></div>`;
  if (ADMIN) {
    $('#adminCount').textContent = `${visibleSongs().length} visible · ${hiddenN} hidden`;
  }
  const clearBtn = $('#clearSearch');
  if (clearBtn) clearBtn.onclick = () => { searchEl.value = ''; sourceFilterEl.value = 'all'; renderTracks(); };
  updateTotalPlays();
}

function setVisible(id, show) {
  const s = songById(id);
  if (!s) return;
  const fileHidden = s.visible === false;
  const hidden = !show;
  // If local override matches file state, drop it (no-op).
  if (hidden === fileHidden) delete localVis[id];
  else localVis[id] = hidden;
  localStorage.setItem('visOverrides', JSON.stringify(localVis));
  // Keep queue clean: hidden tracks leave the queue.
  if (!show) QUEUE = QUEUE.filter((x) => x !== id);
  save(); renderTracks(); renderQueue();
  persistAdminSongs();
}

function renderQueue() {
  if (!QUEUE.length) {
    queueListEl.innerHTML = `<div class="empty">Queue is empty — hit “+ Up Next” on any track.</div>`;
    return;
  }
  queueListEl.innerHTML = QUEUE.map((id, i) => {
    const s = songById(id);
    if (!s) return '';
    return `<li draggable="true" data-i="${i}" class="${id === currentId ? 'playing' : ''}">
      <div class="qt">${i + 1}. ${escapeHtml(s.title)} <span class="badge">${escapeHtml(s.source)}</span></div>
      <div class="qq">
        <button data-q="play" title="Play now">▶</button>
        <button data-q="up" title="Move up">↑</button>
        <button data-q="down" title="Move down">↓</button>
        <button data-q="rm" title="Remove">✕</button>
      </div>
    </li>`;
  }).join('');
  enableQueueDrag();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stopAll() {
  try { audio.pause(); } catch {}
  try { video.pause(); } catch {}
  try { scWidget?.pause(); } catch {}
  scPlaying = false;
  clearInterval(scTimer);
}

async function playId(id, { autoplay = true } = {}) {
  const s = songById(id);
  if (!s) return;
  if (isHidden(s) && !ADMIN) return; // hidden tracks never play for visitors
  stopAll();
  currentId = id;
  activeEngine = s.engine === 'soundcloud' ? 'soundcloud' : 'audio';
  pbTitle.textContent = `${s.title} — ${s.artist || ''}`;
  nowTitle.textContent = s.title;
  nowArtist.textContent = `${s.artist || ''} · ${s.source}`;
  pbArt.innerHTML = artFor(s);
  pbTime.textContent = s.durationSec ? `${fmt(0)} / ${fmt(s.durationSec)}` : 'loading…';
  document.title = `▶ ${s.title} — Qwik`;
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.title, artist: s.artist || 'Qwik', album: 'Streaming only',
        artwork: s.artwork ? [{ src: s.artwork, sizes: '512x512' }] : [],
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
      navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    } catch {}
  }
  playCounts[id] = (playCounts[id] || 0) + 1;
  save(); renderTracks(); renderQueue(); drawWave(0);
  seekEl.value = 0;
  const activeCard = trackListEl.querySelector('.track.active');
  if (activeCard) activeCard.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

  if (activeEngine === 'soundcloud') {
    scInit();
    if (!scWidget) { pbTime.textContent = 'widget failed to load — try refresh'; return; }
    // Allow private SoundCloud tracks: if a full soundcloud.com URL (with
    // secret_token) was provided, load that directly instead of the public API URL.
    const url = (s.audioUrl && /soundcloud\.com/i.test(s.audioUrl))
      ? s.audioUrl
      : `https://api.soundcloud.com/tracks/${s.soundcloudTrackId}`;
    scPos = 0; scDur = (s.durationSec || 0) * 1000;
    try { scWidget.load(url, { auto_play: autoplay, show_artwork: false, visual: false }); }
    catch { pbTime.textContent = 'widget failed to load — try refresh'; return; }
    if (autoplay) scPollStart();
  } else {
    useVideo = s.video === true;
    if (useVideo) {
      video.src = s.audioUrl;
      video.style.display = '';
      wave.style.display = 'none';
      if (autoplay) { try { await video.play(); } catch {} }
    } else {
      video.pause();
      video.style.display = 'none';
      wave.style.display = '';
      audio.src = s.audioUrl;
      audio.preload = 'none';
      if (autoplay) { try { await audio.play(); } catch {} }
    }
  }
  updatePlayBtn();
}
function updatePlayBtn() { playBtn.textContent = isPlaying() ? '⏸' : '▶'; renderTracks(); }

function togglePlay() {
  if (!currentId) {
    const first = (QUEUE[0] && songById(QUEUE[0])) ? QUEUE[0] : visibleSongs()[0]?.id;
    if (first) return playId(first);
    return;
  }
  if (activeEngine === 'soundcloud') {
    if (!scWidget) return;
    if (scPlaying) scWidget.pause(); else { scWidget.play(); scPollStart(); }
  } else {
    if (useVideo) { if (video.paused) video.play().catch(() => {}); else video.pause(); }
    else { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); }
  }
}

function enqueue(id, toFront = false) {
  if (!songById(id)) return;
  QUEUE = QUEUE.filter((x) => x !== id);
  if (toFront) {
    const idx = QUEUE.indexOf(currentId);
    QUEUE.splice(idx < 0 ? 0 : idx + 1, 0, id);
  } else QUEUE.push(id);
  save(); renderQueue();
}
function step(dir) {
  const pool = (QUEUE.length ? QUEUE : visibleSongs().map((s) => s.id)).filter((id) => !isHidden(songById(id) || {}));
  if (!pool.length) return;
  let i = pool.indexOf(currentId);
  if (i < 0) i = dir > 0 ? -1 : 0;
  const n = pool[(i + dir + pool.length) % pool.length];
  if (!QUEUE.includes(n)) enqueue(n);
  playId(n);
}
function cycleRepeat() {
  repeatMode = (repeatMode + 1) % 3;
  const labels = ['Repeat: off', 'Repeat: all', 'Repeat: one'];
  const icons = ['🔁', '🔁', '🔂'];
  repeatBtn.textContent = icons[repeatMode];
  repeatBtn.title = labels[repeatMode];
  showToast(labels[repeatMode]);
}

// --- events ---
trackListEl.addEventListener('click', (e) => {
  const card = e.target.closest('.track');
  if (!card) return;
  const id = card.dataset.id;
  const actEl = e.target.closest('[data-act]');
  const act = actEl ? actEl.dataset.act : e.target.dataset.act;
  if (act === 'play') { if (!QUEUE.includes(id)) enqueue(id); playId(id); }
  if (act === 'add') enqueue(id);
  if (act === 'next') enqueue(id, true);
  if (act === 'hide') setVisible(id, false);
  if (act === 'show') setVisible(id, true);
  if (act === 'edit' && ADMIN) { const s = songById(id); if (s) openEdit(s); }
  if (act === 'moveUp' && ADMIN) {
    const idx = SONGS.findIndex((s) => s.id === id);
    if (idx > 0) { [SONGS[idx - 1], SONGS[idx]] = [SONGS[idx], SONGS[idx - 1]]; renderTracks(); persistAdminSongs(); }
  }
  if (act === 'moveDown' && ADMIN) {
    const idx = SONGS.findIndex((s) => s.id === id);
    if (idx < SONGS.length - 1) { [SONGS[idx + 1], SONGS[idx]] = [SONGS[idx], SONGS[idx + 1]]; renderTracks(); persistAdminSongs(); }
  }
});
queueListEl.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const i = Number(li.dataset.i);
  const id = QUEUE[i];
  const op = e.target.dataset.q;
  if (op === 'play') playId(id);
  if (op === 'rm') { QUEUE.splice(i, 1); save(); renderQueue(); }
  if (op === 'up' && i > 0) { [QUEUE[i - 1], QUEUE[i]] = [QUEUE[i], QUEUE[i - 1]]; save(); renderQueue(); }
  if (op === 'down' && i < QUEUE.length - 1) { [QUEUE[i + 1], QUEUE[i]] = [QUEUE[i], QUEUE[i + 1]]; save(); renderQueue(); }
});
function enableQueueDrag() {
  let dragI = null;
  queueListEl.querySelectorAll('li').forEach((li) => {
    li.addEventListener('dragstart', () => { dragI = Number(li.dataset.i); li.classList.add('dragging'); });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const to = Number(li.dataset.i);
      if (dragI == null || dragI === to) return;
      const [m] = QUEUE.splice(dragI, 1);
      QUEUE.splice(to, 0, m);
      save(); renderQueue();
    });
  });
}

playBtn.onclick = togglePlay;
prevBtn.onclick = () => step(-1);
nextBtn.onclick = () => step(1);
repeatBtn.onclick = cycleRepeat;
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', togglePlay);
    navigator.mediaSession.setActionHandler('pause', togglePlay);
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
  } catch {}
}
audio.addEventListener('play', updatePlayBtn);
audio.addEventListener('pause', updatePlayBtn);
audio.addEventListener('ended', () => {
  if (repeatMode === 2) { audio.currentTime = 0; audio.play().catch(() => {}); }
  else step(1);
});
audio.addEventListener('error', () => {
  if (activeEngine !== 'audio') return;
  showToast('Track unavailable — use a direct audio file URL (e.g. a .m4a), not a share-page link');
});
video.addEventListener('ended', () => {
  if (activeEngine !== 'audio' || !useVideo) return;
  if (repeatMode === 2) { video.currentTime = 0; video.play().catch(() => {}); }
  else step(1);
});
video.addEventListener('timeupdate', () => {
  if (activeEngine !== 'audio' || !useVideo || isSeeking || !video.duration) return;
  paintProgress(video.currentTime, video.duration);
});
video.addEventListener('error', () => {
  if (activeEngine !== 'audio' || !useVideo) return;
  showToast('Video unavailable');
});
audio.addEventListener('timeupdate', () => {
  if (activeEngine !== 'audio' || isSeeking || !audio.duration) return;
  paintProgress(audio.currentTime, audio.duration);
  seekEl.style.setProperty('--fill', `${(audio.currentTime / audio.duration) * 100}%`);
});
seekEl.addEventListener('pointerdown', () => (isSeeking = true));
seekEl.addEventListener('pointerup', () => {
  isSeeking = false;
  const f = seekEl.value / 1000;
  if (activeEngine === 'soundcloud' && scDur) scWidget.seekTo(Math.round(f * scDur));
  else if (useVideo && video.duration) video.currentTime = f * video.duration;
  else if (audio.duration) audio.currentTime = f * audio.duration;
});
volEl.addEventListener('input', () => {
  audio.volume = volEl.value / 100;
  localStorage.setItem('volume', volEl.value);
  try { scWidget?.setVolume(volEl.value); } catch {}
});
const savedVol = localStorage.getItem('volume');
if (savedVol) { volEl.value = savedVol; audio.volume = savedVol / 100; }
else audio.volume = 0.9;

let searchDebounce;
searchEl.addEventListener('input', () => { clearTimeout(searchDebounce); searchDebounce = setTimeout(renderTracks, 150); });
sourceFilterEl.addEventListener('change', renderTracks);
const sortSelect = $('#sortSelect');
if (sortSelect) {
  try { sortSelect.value = localStorage.getItem('sortBy') || 'plays'; } catch {}
  sortSelect.addEventListener('change', () => {
    try { localStorage.setItem('sortBy', sortSelect.value); } catch {}
    renderTracks();
  });
}
$('#shuffleBtn').onclick = () => {
  for (let i = QUEUE.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [QUEUE[i], QUEUE[j]] = [QUEUE[j], QUEUE[i]];
  }
  save(); renderQueue();
};
$('#clearBtn').onclick = () => {
  const backup = [...QUEUE];
  QUEUE = []; save(); renderQueue();
  showToast('Queue cleared');
  setTimeout(() => {
    if (!QUEUE.length) {
      const undo = document.createElement('button');
      undo.textContent = 'Undo';
      undo.className = 'ghost';
      undo.onclick = () => { QUEUE = backup; save(); renderQueue(); toast.hidden = true; };
      toast.appendChild(undo);
    }
  }, 100);
};
$('#queueToggle').onclick = () => {
  const open = queuePanel.classList.toggle('open');
  const bd = $('#queueBackdrop');
  if (bd) bd.hidden = !open;
};
const qbd = $('#queueBackdrop');
if (qbd) qbd.addEventListener('click', () => {
  queuePanel.classList.remove('open');
  qbd.hidden = true;
});
// Horizontal rail: arrows scroll by ~2 cards; swipe/drag works natively.
function railStep(dir) {
  const card = trackListEl.querySelector('.track');
  const w = card ? card.getBoundingClientRect().width + 12 : 480;
  trackListEl.scrollBy({ left: dir * w * 2, behavior: 'smooth' });
}
const railPrev = $('#railPrev'); if (railPrev) railPrev.onclick = () => railStep(-1);
const railNext = $('#railNext'); if (railNext) railNext.onclick = () => railStep(1);
// Arrow keys move the rail when it's focused.
trackListEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { e.preventDefault(); railStep(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); railStep(-1); }
});

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('audio, .art, .pb-art, #wave')) e.preventDefault();
});
document.addEventListener('dragstart', (e) => {
  if (e.target.closest('img')) e.preventDefault();
});

function applyDeepLink() {
  const id = new URLSearchParams(location.search).get('t');
  const s = id && songById(id);
  if (s && (ADMIN || !isHidden(s))) { if (!QUEUE.includes(id)) enqueue(id); playId(id, { autoplay: false }); }
  else if (id) showToast('Track not found or unavailable');
}

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': e.preventDefault(); seekBy(5); break;
    case 'ArrowLeft': e.preventDefault(); seekBy(-5); break;
    case 'ArrowUp': e.preventDefault(); e.preventDefault(); volEl.value = Math.min(100, +volEl.value + 5); volEl.dispatchEvent(new Event('input')); break;
    case 'ArrowDown': e.preventDefault(); volEl.value = Math.max(0, +volEl.value - 5); volEl.dispatchEvent(new Event('input')); break;
    case 'n': case 'N': step(1); break;
    case 'p': case 'P': step(-1); break;
    case '/': e.preventDefault(); searchEl.focus(); break;
  }
});
function seekBy(sec) {
  if (activeEngine === 'soundcloud' && scDur) {
    scWidget.seekTo(Math.max(0, Math.min(scDur, scPos + sec * 1000)));
  } else if (useVideo && video.duration) {
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + sec));
  } else if (audio.duration) {
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + sec));
  }
}

function mergeAdminSongs(base) {
  // Apply the admin's working copy on this browser even when dev mode is off,
  // so manually added/edited tracks survive refreshes. Visitors without this
  // localStorage key just see the published songs.json.
  try {
    const saved = JSON.parse(localStorage.getItem('adminSongs') || 'null');
    const deleted = new Set(JSON.parse(localStorage.getItem('adminDeleted') || '[]'));
    if (!Array.isArray(saved)) return base;
    const byId = new Map(base.map((s) => [s.id, s]));
    const savedById = new Map(saved.map((s) => [s.id, s]));
    const merged = [];
    for (const b of base) {
      if (deleted.has(b.id)) continue;
      const s = savedById.get(b.id);
      if (!s) { merged.push(b); continue; }
      // Apply admin curation on top of fresh upstream data, but keep upstream-
      // refreshed fields (plays, audioUrl on BandLab CDN, artwork, duration)
      // from the published base so sync updates are not clobbered by stale
      // working-copy values.
      const m = { ...b };
      if (s.visible !== undefined) m.visible = s.visible;
      if (s.order !== undefined) m.order = s.order;
      // Manual audioUrl override (e.g. pointed at own R2 file) survives.
      if (s.audioUrl && s.audioUrl !== b.audioUrl && !s.audioUrl.startsWith('https://static.bandlab.com')) {
        m.audioUrl = s.audioUrl;
        if (s.engine) m.engine = s.engine;
      }
      // Manual artwork override survives.
      if (s.artwork && s.artwork !== b.artwork && !isBadArt(s.artwork)) {
        m.artwork = s.artwork;
      }
      // Manual Rap Fame play count survives.
      if (s.rapfamePlays) m.rapfamePlays = s.rapfamePlays;
      // Video flag survives.
      if (s.video !== undefined) m.video = s.video;
      // Plays come from the fresh base (sync keeps them current). A manually
      // entered Rap Fame count is added only when no scraped match exists.
      m.plays = b.plays || 0;
      const baseRf = b.rapfamePlays || 0;
      const baseScraped = b.rapfameScraped || false;
      const savedRf = s.rapfamePlays || 0;
      if (!baseScraped && !baseRf && savedRf) m.plays = (m.plays || 0) + savedRf;
      m.rapfamePlays = baseRf || savedRf || 0;
      m.rapfameScraped = baseScraped;
      merged.push(m);
    }
    for (const s of saved) {
      if (!byId.has(s.id) && !deleted.has(s.id)) merged.push(s);
    }
    return merged;
  } catch { return base; }
}
function persistAdminSongs() {
  if (!ADMIN) return;
  try { localStorage.setItem('adminSongs', JSON.stringify(SONGS)); } catch {}
}
function markAdminDeleted(id) {
  try {
    const arr = JSON.parse(localStorage.getItem('adminDeleted') || '[]');
    if (!arr.includes(id)) { arr.push(id); localStorage.setItem('adminDeleted', JSON.stringify(arr)); }
  } catch {}
}
// --- admin edit modal ---
function genId() { return 'tr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function openEdit(track) {
  const modal = $('#editModal');
  if (!modal) return;
  $('#editModalTitle').textContent = track ? 'Edit track' : 'Add track';
  $('#editId').value = track ? track.id : '';
  $('#editTitleInput').value = track?.title || '';
  $('#editArtist').value = track?.artist || '';
  $('#editEngine').value = track?.engine === 'soundcloud' ? 'soundcloud' : 'audio';
  $('#editAudioUrl').value = track?.audioUrl || '';
  $('#editScId').value = track?.soundcloudTrackId || '';
  $('#editArtwork').value = track?.artwork || '';
  $('#editSourceUrl').value = track?.sourceUrl || '';
  $('#editAltSourceUrl').value = track?.altSourceUrl || '';
  $('#editDuration').value = track?.durationSec || '';
  $('#editRfPlays').value = track?.rapfamePlays || '';
  $('#editVisible').checked = track ? (track.visible !== false && !isHidden(track)) : true;
  $('#editVideo').checked = track ? (track.video === true) : false;
  $('#editDelete').style.display = track ? '' : 'none';
  modal.hidden = false;
}
function closeEdit() { const m = $('#editModal'); if (m) m.hidden = true; }

const editForm = $('#editForm');
if (editForm) {
  editForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('#editId').value.trim() || genId();
    const engine = $('#editEngine').value;
    const altUrl = $('#editAltSourceUrl').value.trim();
    const data = {
      id,
      title: $('#editTitleInput').value.trim() || 'Untitled',
      artist: $('#editArtist').value.trim() || 'Qwik',
      engine,
      audioUrl: $('#editAudioUrl').value.trim(),
      soundcloudTrackId: $('#editScId').value.trim(),
      artwork: $('#editArtwork').value.trim(),
      sourceUrl: $('#editSourceUrl').value.trim(),
      altSourceUrl: altUrl,
      altSource: altUrl ? 'soundcloud' : undefined,
      durationSec: Number($('#editDuration').value) || 0,
      rapfamePlays: Number($('#editRfPlays').value) || 0,
      video: $('#editVideo').checked,
      source: engine === 'soundcloud' ? 'soundcloud' : 'bandlab',
      visible: $('#editVisible').checked,
    };
    const existing = SONGS.find((s) => s.id === id);
    const existingRf = existing?.rapfamePlays || 0;
    const existingScraped = existing?.rapfameScraped || false;
    const existingPlays = existing?.plays || 0;
    const basePlays = existingScraped ? existingPlays : existingPlays - existingRf;
    data.plays = basePlays + (data.rapfamePlays || 0);
    data.rapfameScraped = existingScraped;
    const idx = SONGS.findIndex((s) => s.id === id);
    if (idx >= 0) SONGS[idx] = { ...SONGS[idx], ...data };
    else SONGS.push(data);
    delete localVis[id];
    try { localStorage.setItem('visOverrides', JSON.stringify(localVis)); } catch {}
    closeEdit();
    renderTracks();
    persistAdminSongs();
    showToast('Track saved');
  });
}
const editCancel = $('#editCancel');
if (editCancel) editCancel.addEventListener('click', closeEdit);
const editDelete = $('#editDelete');
if (editDelete) editDelete.addEventListener('click', () => {
  const id = $('#editId').value.trim();
  if (!id) { closeEdit(); return; }
  if (!confirm('Delete this track?')) return;
  SONGS = SONGS.filter((s) => s.id !== id);
  delete localVis[id];
  try { localStorage.setItem('visOverrides', JSON.stringify(localVis)); } catch {}
  markAdminDeleted(id);
  QUEUE = QUEUE.filter((x) => x !== id);
  save(); closeEdit(); renderTracks(); renderQueue();
  persistAdminSongs();
  showToast('Track deleted');
});
const editModal = $('#editModal');
if (editModal) editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEdit(); });

// --- contact modal (obfuscated details) ---
const _wa = 'KzE1MDUzOTkyODIz';
const _em = 'YmFyY29zeXNkZXZAZ21haWwuY29t';
const contactBtn = $('#contactBtn');
const contactModal = $('#contactModal');
function openContact() {
  if (!contactModal) return;
  try {
    const wa = atob(_wa).replace(/^\+/, '');
    const em = atob(_em);
    const waLink = $('#contactWa');
    const emLink = $('#contactEmail');
    if (waLink) waLink.href = `https://wa.me/${wa}`;
    if (emLink) emLink.href = `mailto:${em}`;
  } catch {}
  contactModal.hidden = false;
}
function closeContact() { if (contactModal) contactModal.hidden = true; }
if (contactBtn) contactBtn.addEventListener('click', openContact);
if (contactModal) contactModal.addEventListener('click', (e) => { if (e.target === contactModal) closeContact(); });
const contactCancel = $('#contactCancel');
if (contactCancel) contactCancel.addEventListener('click', closeContact);

// boot
try {
  const res = await fetch('./songs.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  baseSongs = await res.json();
  SONGS = mergeAdminSongs(baseSongs);
} catch (err) {
  trackListEl.innerHTML = `<div class="empty" style="flex:1">
    <strong>Failed to load tracks.</strong><br><br>
    <button id="retryBtn" class="play">Retry</button>
  </div>`;
  $('#retryBtn').onclick = () => location.reload();
  throw err;
}
// show swipe hint on first visit (mobile)
if ('ontouchstart' in window && !localStorage.getItem('swipeHintSeen')) {
  const hint = $('#swipeHint');
  hint.hidden = false;
  setTimeout(() => { hint.hidden = true; localStorage.setItem('swipeHintSeen', '1'); }, 4000);
}
// preload next 3 queue artwork
QUEUE.slice(0, 3).forEach((id) => {
  const s = songById(id);
  if (s?.artwork && !isBadArt(s.artwork)) { const img = new Image(); img.src = s.artwork; }
});
QUEUE = QUEUE.filter((id) => songById(id) && !isHidden(songById(id)));
if (!QUEUE.length) QUEUE = visibleSongs().map((s) => s.id);
function setupAdminUI() {
  const bar = $('#adminBar');
  if (!ADMIN) {
    if (bar) bar.hidden = true;
    const btn = $('#devToggle');
    if (btn) btn.classList.remove('on');
    return;
  }
  if (bar) bar.hidden = false;
  const btn = $('#devToggle');
  if (btn) btn.classList.add('on');
  const exportBtn = $('#exportBtn');
  if (exportBtn && !exportBtn._wired) {
    exportBtn._wired = true;
    exportBtn.onclick = () => {
      const da = defaultArtwork();
      const out = SONGS.map((s, i) => ({ ...s, order: i, visible: !isHidden(s), artwork: (s.artwork && !isBadArt(s.artwork)) ? s.artwork : (da || s.artwork || '') }));
      const blob = new Blob([JSON.stringify(out, null, 2) + '\n'], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'songs.json';
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }
  const bulkHideBtn = $('#bulkHideBtn');
  if (bulkHideBtn && !bulkHideBtn._wired) {
    bulkHideBtn._wired = true;
    bulkHideBtn.onclick = () => {
      const checked = trackListEl.querySelectorAll('.admin-check:checked');
      checked.forEach((cb) => setVisible(cb.dataset.id, false));
      showToast(`Hidden ${checked.length} track${checked.length === 1 ? '' : 's'}`);
    };
  }
  const bulkShowBtn = $('#bulkShowBtn');
  if (bulkShowBtn && !bulkShowBtn._wired) {
    bulkShowBtn._wired = true;
    bulkShowBtn.onclick = () => {
      const checked = trackListEl.querySelectorAll('.admin-check:checked');
      checked.forEach((cb) => setVisible(cb.dataset.id, true));
      showToast(`Shown ${checked.length} track${checked.length === 1 ? '' : 's'}`);
    };
  }
  const addTrackBtn = $('#addTrackBtn');
  if (addTrackBtn && !addTrackBtn._wired) {
    addTrackBtn._wired = true;
    addTrackBtn.onclick = () => openEdit(null);
  }
  const defaultCoverBtn = $('#defaultCoverBtn');
  if (defaultCoverBtn && !defaultCoverBtn._wired) {
    defaultCoverBtn._wired = true;
    defaultCoverBtn.onclick = () => {
      const url = window.prompt('Default cover image URL (blank to clear):', defaultArtwork());
      if (url === null) return;
      try { localStorage.setItem('defaultArtwork', url.trim()); } catch {}
      renderTracks();
      showToast(url.trim() ? 'Default cover set' : 'Default cover cleared');
    };
  }
  const bannerBtn = $('#bannerBtn');
  if (bannerBtn && !bannerBtn._wired) {
    bannerBtn._wired = true;
    bannerBtn.onclick = () => {
      const url = window.prompt('Banner image URL (shown in the QWIK badge; blank to clear):', bannerImage());
      if (url === null) return;
      try { localStorage.setItem('bannerImage', url.trim()); } catch {}
      applyBanner();
      showToast(url.trim() ? 'Banner set' : 'Banner cleared');
    };
  }
}
function setAdmin(on) {
  ADMIN = !!on;
  if (ADMIN_HASH) {
    try {
      if (ADMIN) sessionStorage.setItem('adminSession', '1');
      else sessionStorage.removeItem('adminSession');
    } catch {}
  } else {
    try { localStorage.setItem('adminMode', ADMIN ? '1' : '0'); } catch {}
  }
  if (baseSongs.length) SONGS = mergeAdminSongs(baseSongs);
  setupAdminUI();
  renderTracks();
  showToast(ADMIN ? 'Dev mode ON' : 'Dev mode OFF');
}
const devToggle = $('#devToggle');
if (devToggle) {
  devToggle.addEventListener('click', async () => {
    if (ADMIN) { setAdmin(false); return; }
    if (!ADMIN_HASH) { setAdmin(true); return; }
    const pw = window.prompt('Admin password:');
    if (pw === null) return;
    if (await adminPasswordOk(pw)) setAdmin(true);
    else showToast('Wrong password');
  });
  devToggle.addEventListener('contextmenu', (e) => { e.preventDefault(); setAdmin(false); });
}
setupAdminUI();
applyBanner();
applyTheme();
applyView();
const themeToggle = $('#themeToggle');
if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
const viewToggle = $('#viewToggle');
if (viewToggle) viewToggle.addEventListener('click', toggleView);
renderTracks(); renderQueue(); drawWave(0);
if (currentId && songById(currentId)) playId(currentId, { autoplay: false });
else if (visibleSongs()[0]) {
  const s = visibleSongs()[0];
  pbTitle.textContent = `${s.title} — ${s.artist || ''}`;
  nowTitle.textContent = s.title; nowArtist.textContent = s.artist || '';
  currentId = s.id; activeEngine = s.engine === 'soundcloud' ? 'soundcloud' : 'audio';
  drawWave(0);
}
applyDeepLink();
