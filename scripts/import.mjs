// Import: builds songs.json from your real profiles.
// - SoundCloud: scrape /aaron2z/tracks noscript links + official oEmbed per track
// - BandLab: public posts API (your own songs) -> direct mixdown .m4a streaming
// - Rap Fame: paginated API for all tracks (play counts + audio)
// - Dedupe: same song on both platforms -> ONE entry (BandLab direct audio wins,
//   SoundCloud kept as alt link so plays still flow if listener clicks through)
// - Preserves your curation: `visible:false` and manual `audioUrl` overrides in
//   the existing songs.json survive re-imports (matched by id).
// - Preserves manually added tracks (ids not present upstream).
// - Combines play counts across SoundCloud, BandLab, and Rap Fame.
// Run: node scripts/import.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SONGS_PATH = new URL('../songs.json', import.meta.url);
const SC_PROFILE = 'https://soundcloud.com/aaron2z/tracks';
const BL_POSTS = 'https://www.bandlab.com/api/v1.3/users/realqwik/posts?count=50';
const RF_API = 'https://www.api-battleme.com/battleme/tracks/promos';
const RF_USER = 1761260;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'track';
}
function normTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^qwik/, '').replace(/qwik$/, '').replace(/^the/, '');
}

let prev = [];
try { if (existsSync(SONGS_PATH)) prev = JSON.parse(readFileSync(SONGS_PATH, 'utf8')); } catch {}
const prevById = new Map(prev.map((s) => [s.id, s]));

// --- SoundCloud ---
console.log('Fetching SoundCloud profile…');
const scHtml = await (await fetch(SC_PROFILE, { headers: UA })).text();
const links = [...new Set(
  [...scHtml.matchAll(/href="(\/aaron2z\/[a-z0-9-]+)"/gi)].map((m) => m[1])
    .filter((p) => !['/aaron2z/likes', '/aaron2z/sets', '/aaron2z/tracks', '/aaron2z/comments', '/aaron2z/popular-tracks', '/aaron2z/albums'].includes(p))
)];
console.log(`found ${links.length} SC tracks`);
const scTracks = [];
for (const path of links) {
  const url = `https://soundcloud.com${path}`;
  const id = 'sc-' + slug(path.split('/').pop());
  const old = prevById.get(id);
  if (old) {
    let plays = old.plays || 0;
    if (!plays) {
      try {
        const page = await fetch(url, { headers: UA }).then((x) => x.text());
        const m = page.match(/"playback_count":(\d+)/) || page.match(/"plays":(\d+)/);
        if (m) plays = Number(m[1]) || 0;
      } catch {}
    }
    scTracks.push({
      id,
      title: old.title,
      artist: old.artist || 'Qwik',
      engine: 'soundcloud',
      soundcloudTrackId: old.soundcloudTrackId || '',
      audioUrl: old.audioUrl || '',
      artwork: old.artwork || '',
      durationSec: old.durationSec || 0,
      source: 'soundcloud',
      sourceUrl: url,
      releaseDate: old.releaseDate || '',
      plays,
    });
    continue;
  }
  try {
    const r = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`, { headers: UA });
    if (!r.ok) { console.warn('  skip', url, r.status); continue; }
    const j = await r.json();
    const trackId = (j.html.match(/tracks%2F(\d+)/) || j.html.match(/tracks\/(\d+)/) || [])[1] || '';
    let plays = 0;
    try {
      const page = await fetch(url, { headers: UA }).then((x) => x.text());
      const m = page.match(/"playback_count":(\d+)/) || page.match(/"plays":(\d+)/);
      if (m) plays = Number(m[1]) || 0;
    } catch {}
    scTracks.push({
      id,
      title: j.title.replace(/\s+by\s+Qwik$/i, ''),
      artist: 'Qwik',
      engine: 'soundcloud',
      soundcloudTrackId: trackId,
      audioUrl: '',
      artwork: (j.thumbnail_url || '').replace('-large.', '-t500x500.'),
      durationSec: 0,
      source: 'soundcloud',
      sourceUrl: url,
      releaseDate: '',
      plays,
    });
  } catch (e) { console.warn('  err', url, e.message); }
}

// --- BandLab ---
console.log('Fetching BandLab posts…');
const bl = await (await fetch(BL_POSTS, { headers: { ...UA, Accept: 'application/json' } })).json();
const seen = new Map();
for (const p of bl.data || []) {
  const rev = p.revision || {};
  const song = rev.song || {};
  if (!song.id || seen.has(song.id)) continue;
  const mix = rev.mixdown || {};
  if (!mix.file) continue;
  seen.set(song.id, {
    id: 'bl-' + slug(song.slug || song.name),
    title: song.name,
    artist: 'qwik',
    engine: 'audio',
    audioUrl: mix.file,
    artwork: (song.picture?.url || '') + '500x500',
    durationSec: Math.round(mix.duration || 0),
    source: 'bandlab',
    sourceUrl: `https://www.bandlab.com/realqwik/${song.slug || ''}`,
    releaseDate: (rev.createdOn || '').slice(0, 10),
    plays: rev.counters?.plays || 0,
  });
}
const blTracks = [...seen.values()].sort((a, b) => (b.plays || 0) - (a.plays || 0));
console.log(`found ${blTracks.length} BandLab songs`);

// --- Rap Fame: paginated API for all tracks ---
console.log('Fetching Rap Fame profile…');
const rfTracks = [];
try {
  let maxId = '';
  let page = 0;
  while (page < 50) {
    const apiUrl = maxId
      ? `${RF_API}?maxId=${maxId}&userId=${RF_USER}&count=20`
      : `${RF_API}?userId=${RF_USER}&count=20`;
    const resp = await fetch(apiUrl, { headers: UA });
    if (!resp.ok) { console.warn('  Rap Fame API', resp.status); break; }
    const json = await resp.json();
    const items = json.result || [];
    if (!items.length) break;
    for (const t of items) {
      if (!t || !t.trackId) continue;
      rfTracks.push({
        id: 'rf-' + t.trackId,
        title: t.name,
        artist: 'qwik',
        engine: 'audio',
        audioUrl: t.url || '',
        artwork: t.imgUrl || '',
        durationSec: Math.round(t.lengthSec || 0),
        source: 'rapfame',
        sourceUrl: t.shareUrl || `https://rapfame.app/tracks/${t.trackId}`,
        releaseDate: '',
        plays: t.playbackCount || 0,
      });
    }
    const last = items[items.length - 1];
    maxId = 'tr:' + last.trackId;
    page++;
    if (items.length < 20) break;
  }
  console.log(`found ${rfTracks.length} Rap Fame tracks`);
} catch (e) { console.warn('  Rap Fame fetch failed:', e.message); }

// --- Combine Rap Fame play counts into matching existing tracks ---
const rfByNorm = new Map();
for (const t of rfTracks) {
  const k = normTitle(t.title);
  if (!rfByNorm.has(k)) rfByNorm.set(k, t);
}
for (const t of blTracks) {
  const rf = rfByNorm.get(normTitle(t.title));
  if (rf) t.plays = (t.plays || 0) + (rf.plays || 0);
}
// --- Dedupe: same song SC+BL -> keep BandLab, link SC as alt ---
const blByNorm = new Map();
for (const t of blTracks) {
  const k = normTitle(t.title);
  if (!blByNorm.has(k)) blByNorm.set(k, []);
  blByNorm.get(k).push(t);
}
const keptSc = [];
let merged = 0;
for (const sc of scTracks) {
  const k = normTitle(sc.title);
  const blGroup = blByNorm.get(k);
  if (blGroup?.length) {
    const top = [...blGroup].sort((a, b) => (b.plays || 0) - (a.plays || 0))[0];
    if (!top.altSourceUrl) { top.altSourceUrl = sc.sourceUrl; top.altSource = 'soundcloud'; }
    // sc.plays is SC-only (RF is added to the BL entry above). Add SC only.
    const scBase = sc.plays || 0;
    top.plays = (top.plays || 0) + scBase;
    merged++;
    console.log(`  merge: "${sc.title}" -> BandLab entry (SC kept as alt link)`);
  } else {
    const rf = rfByNorm.get(normTitle(sc.title));
    if (rf) sc.plays = (sc.plays || 0) + (rf.plays || 0);
    keptSc.push(sc);
  }
}

// --- Rap Fame tracks that don't match an existing track become their own entries ---
const existingNorms = new Set([...keptSc, ...blTracks].map((t) => normTitle(t.title)));
const rfNew = rfTracks.filter((t) => !existingNorms.has(normTitle(t.title)));

const upstream = [...keptSc, ...blTracks, ...rfNew].map((t) => {
  const old = prevById.get(t.id);
  const manualAudio = old?.audioUrl && !old.audioUrl.startsWith('https://static.bandlab.com')
    ? old.audioUrl : null;
  const rfMatch = rfByNorm.get(normTitle(t.title));
  const manualRf = old?.rapfamePlays || t.rapfamePlays || 0;
  const storedRf = rfMatch?.plays ? (rfMatch.plays || 0) : (manualRf || 0);
  const scraped = !!rfMatch;
  // plays already includes scraped rf (added above) for matched tracks.
  let finalPlays = t.plays || 0;
  // For non-matched (including rapfame-only) with manual rapfamePlays, already counted if rfMatch. 
  // For upstream tracks without rfMatch but with manualRf, add it.
  if (!scraped && manualRf && t.source !== 'rapfame') {
    finalPlays = (t.plays || 0) + manualRf;
  }
  return {
    ...t,
    plays: finalPlays,
    rapfamePlays: storedRf,
    rapfameScraped: scraped || t.source === 'rapfame',
    visible: old?.visible ?? true,
    ...(manualAudio ? { audioUrl: manualAudio, engine: 'audio' } : {}),
  };
});
const upstreamIds = new Set(upstream.map((t) => t.id));
const manual = prev.filter((s) => !upstreamIds.has(s.id));
const all = [...upstream, ...manual];
writeFileSync(SONGS_PATH, JSON.stringify(all, null, 2) + '\n');
const hidden = all.filter((t) => t.visible === false).length;
console.log(`\nwrote songs.json: ${all.length} entries (${keptSc.length} SC-only + ${blTracks.length} BandLab + ${rfNew.length} Rap Fame, ${merged} SC merged as alt links${hidden ? `, ${hidden} hidden by you` : ''})`);