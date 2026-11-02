# Qwik — streaming-only player

Minimal custom player for **Qwik**: 35 tracks (3 SoundCloud-only + 32 BandLab,
7 dupes merged), Up Next queue, no downloads. Static site — free on Render,
custom domain later.

## How playback works

- **BandLab tracks** (`engine: audio`): stream direct from your public BandLab
  mixdown files (`static.bandlab.com/...m4a`) through a single `<audio>` element.
  Zero uploads needed. Original BandLab page linked per track.
- **SoundCloud tracks** (`engine: soundcloud`): play through SoundCloud's official
  widget (`w.soundcloud.com/player`) hidden behind this custom skin via the
  Widget API — plays/views still count on SoundCloud, no API key needed.
- One queue mixes both engines. Switching tracks stops the other engine.

## Quick start (local, no git needed)

```bash
npx serve . -l 5173
# open http://localhost:5173
```

## Curate what shows (private admin)

Admin mode can be toggled with the discreet ⚙ button in the bottom-right corner
(no URL needed — works on any host, including GitHub Pages), or by opening the
site with `?admin=1` / `#admin=1`:

- Your choice is remembered on this browser (localStorage). The ⚙ button is
  deliberately subtle so visitors are unlikely to find it.

- Every track gets **🚫 Hide / 👁 Show**, **✏ Edit** (title, artist, artwork URL,
  private audio URL, source links, duration, visible flag), **+ Add track**, and
  **Set default cover** for tracks without artwork. Hidden tracks vanish from the
  list,
  queue, search and deep-links for everyone else (dimmed preview for you).
- **⬇ Export songs.json** downloads the catalog with your choices baked in —
- Private/unreleased tracks: use **✏ Edit → Audio URL** with a *direct* audio
  file URL (.m4a). BandLab share-page links are not playable; host the file
  (e.g. Cloudflare R2) or use a SoundCloud secret link with the soundcloud
  engine.
  replace `songs.json` with it to make it live for everyone.

Hiding is instant on your machine; exporting makes it permanent site-wide.

## Refresh catalog

```bash
node scripts/import.mjs
```

Pulls your live profiles and rewrites `songs.json`:
- SC: `soundcloud.com/aaron2z/tracks` noscript links + official oEmbed each
- BL: `bandlab.com/api/v1.3/users/realqwik/posts` (your own songs) → title,
  artwork `500x500`, duration, direct `.m4a`, per-track page link
- **Dedupe**: a song on both platforms becomes ONE entry — BandLab direct
  audio wins, SoundCloud kept as an "Also on SoundCloud ↗" alt link.
- **Your curation survives**: `visible:false` flags and manual `audioUrl`
  overrides (e.g. you pointed a track at your own R2 file) are preserved
  across re-imports.

GitHub Action (`.github/workflows/sync.yml`) runs this daily at 09:00 UTC and
commits `songs.json` — no secrets needed, no dependencies.

## Deploy on GitHub Pages

1. Push to `main`. The `deploy-pages` workflow builds and publishes the site.
2. In repo settings → Pages → Source: **GitHub Actions**.
3. (Optional) Add a repo secret `ADMIN_PASSWORD`. The workflow injects its
   SHA-256 hash into `config.js`; the ⚙ toggle then requires that password.
   Without the secret, dev mode stays open (local-dev behavior).
4. Daily sync (`daily-sync.yml`) still commits `songs.json` to `main`, which
   re-triggers a deploy.

## Deploy on Render (when ready, other account)

1. Push folder to GitHub. 2. Render → New Static Site → empty build cmd,
   publish `./`. 3. Auto-deploy on. 4. Custom domain later via CNAME.

## No-download notes

`<audio controlsList="nodownload">`, no `<a download>`, context-menu/drag
blocked on art. BandLab `.m4a` serves `attachment` disposition from S3 but
streams inline in the player. True rip-proofing isn't possible in a browser —
this deters casual saving (V2: signed URLs / HLS if ever needed).
