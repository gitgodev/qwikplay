// Qwik — hybrid streaming player with Up Next queue.
// - BandLab (engine:'audio'): direct <audio> streaming of public mixdown .m4a
// - SoundCloud (engine:'soundcloud'): official hidden Widget, custom skin drives it
// - Queue persisted to localStorage. No <a download> anywhere (deterrence, not DRM).

const $ = (s) => document.querySelector(s);
const audio = $('#audio');
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

// Private admin mode: open the site with ?admin=1 to curate.
// Visitors never see this (no link to it anywhere on the page).
const ADMIN = new URLSearchParams(location.search).has('admin');
// Local visibility overrides (id -> true = hidden). Export writes them to songs.json.
let localVis = {};
try { localVis = JSON.parse(localStorage.getItem('visOverrides') || '{}'); } catch { localVis = {}; }
function isHidden(s) { return localVis[s.id] ?? (s.visible === false); }
function visibleSongs() { return SONGS.filter((s) => !isHidden(s)); }

let SONGS = [];
let QUEUE = [];
let currentId = null;
let isSeeking = false;
let activeEngine = 'audio'; // 'audio' | 'soundcloud'
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
function isPlaying() { return activeEngine === 'soundcloud' ? scPlaying : !audio.paused; }
// Default cover: gradient disc + first letter, used when a CDN image fails or is a placeholder.
window.__artFallback = (t) => {
  const ch = ((t || '?').trim().charAt(0) || '?').toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='500' height='500'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#7df0c6'/><stop offset='1' stop-color='#8ab4ff'/></linearGradient></defs><rect width='500' height='500' fill='#141821'/><circle cx='250' cy='215' r='105' fill='url(#g)' opacity='0.9'/><text x='250' y='253' font-size='110' text-anchor='middle' fill='#0b0d12' font-family='sans-serif' font-weight='bold'>${ch.replace(/[<>&]/g, '')}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};
function isBadArt(url) {
  if (!url) return true;
  return url.includes('fb_placeholder') || url.includes('placeholder') || url.includes('default');
}
function artFor(s, fallbackEmoji = '♪') {
  if (s?.artwork && !isBadArt(s.artwork)) {
    return `<img src="${s.artwork}" alt="${escapeHtml(s.title || 'cover')}" loading="lazy" draggable="false" referrerpolicy="no-referrer" data-t="${escapeHtml(s.title || '?')}" onerror="this.onerror=null;this.src=window.__artFallback(this.dataset.t)" />`;
  }
  if (s?.artwork) return `<img src="${window.__artFallback(s.title)}" alt="${escapeHtml(s.title || 'cover')}" draggable="false" />`;
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
  const list = pool.filter((s) => {
    const okQ = !q || `${s.title} ${s.artist}`.toLowerCase().includes(q);
    const okS = src === 'all' || s.source === src;
    return okQ && okS;
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
        <button data-act="moveUp" class="ghost" title="Move up">↑</button>
        <button data-act="moveDown" class="ghost" title="Move down">↓</button>
      </div>` : '';
    return `
    <div class="track ${isCurrent ? 'active' : ''} ${hidden ? 'is-hidden' : ''}" data-id="${s.id}">
      <div class="art">${artFor(s)}</div>
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
    const url = `https://api.soundcloud.com/tracks/${s.soundcloudTrackId}`;
    scPos = 0; scDur = (s.durationSec || 0) * 1000;
    try { scWidget.load(url, { auto_play: autoplay, show_artwork: false, visual: false }); }
    catch { pbTime.textContent = 'widget failed to load — try refresh'; return; }
    if (autoplay) scPollStart();
  } else {
    audio.src = s.audioUrl;
    audio.preload = 'none';
    if (autoplay) { try { await audio.play(); } catch {} }
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
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
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
  const act = e.target.dataset.act;
  if (act === 'play') { if (!QUEUE.includes(id)) enqueue(id); playId(id); }
  if (act === 'add') enqueue(id);
  if (act === 'next') enqueue(id, true);
  if (act === 'hide') setVisible(id, false);
  if (act === 'show') setVisible(id, true);
  if (act === 'moveUp' && ADMIN) {
    const idx = SONGS.findIndex((s) => s.id === id);
    if (idx > 0) { [SONGS[idx - 1], SONGS[idx]] = [SONGS[idx], SONGS[idx - 1]]; renderTracks(); }
  }
  if (act === 'moveDown' && ADMIN) {
    const idx = SONGS.findIndex((s) => s.id === id);
    if (idx < SONGS.length - 1) { [SONGS[idx + 1], SONGS[idx]] = [SONGS[idx], SONGS[idx + 1]]; renderTracks(); }
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
$('#queueToggle').onclick = () => queuePanel.classList.toggle('hidden');
// Horizontal rail: arrows scroll by ~2 cards; swipe/drag works natively.
function railStep(dir) {
  const card = trackListEl.querySelector('.track');
  const w = card ? card.getBoundingClientRect().width + 12 : 480;
  trackListEl.scrollBy({ left: dir * w * 2, behavior: 'smooth' });
}
$('#railPrev').onclick = () => railStep(-1);
$('#railNext').onclick = () => railStep(1);
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
  } else if (audio.duration) {
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + sec));
  }
}

// boot
try {
  const res = await fetch('./songs.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  SONGS = await res.json();
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
if (ADMIN) {
  $('#adminBar').hidden = false;
  $('#exportBtn').onclick = () => {
    const out = SONGS.map((s, i) => ({ ...s, order: i, visible: !isHidden(s) }));
    const blob = new Blob([JSON.stringify(out, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'songs.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#bulkHideBtn').onclick = () => {
    const checked = trackListEl.querySelectorAll('.admin-check:checked');
    checked.forEach((cb) => setVisible(cb.dataset.id, false));
    showToast(`Hidden ${checked.length} track${checked.length === 1 ? '' : 's'}`);
  };
  $('#bulkShowBtn').onclick = () => {
    const checked = trackListEl.querySelectorAll('.admin-check:checked');
    checked.forEach((cb) => setVisible(cb.dataset.id, true));
    showToast(`Shown ${checked.length} track${checked.length === 1 ? '' : 's'}`);
  };
}
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
