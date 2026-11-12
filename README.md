# Sonar

An explorable map of musicians and the bands, projects and records that connect them.

**Search any artist** and the site shows their connections (bands, members, collaborations, supporting musicians, people they made records with), from [MusicBrainz](https://musicbrainz.org) and [Discogs](https://www.discogs.com). It runs in the browser with no server.
- Click a connected artist to expand them too.
- Every artist has a shareable link (`#<musicbrainz-id>`).
- "How are they connected?" finds the shortest path between two artists on the map.

Connections come from a **prebuilt index**, so even a 44-member band and every member's other bands load in about a second. The index combines two public data dumps:
- [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_Database/Download) supplies band membership, collaborations and supporting musicians.
- [Discogs](https://data.discogs.com/) release credits (CC0) add **"worked together"** links: featured artists, players, producers and writers credited on the same release. This covers what MusicBrainz misses, such as Ichiko Aoba × Ryuichi Sakamoto. Only musical credits count, never engineering, mastering or design. Each artist nominates its top 30 Discogs collaborators by shared releases. A link is kept if either side nominated it (`DISCOGS_PER_ARTIST`; `DISCOGS_MAX` optionally caps any artist's total). Artists are matched through the Discogs links on MusicBrainz.

The index lives under `public/index/` as gzipped JSON (the browser decompresses it), split **by neighbourhood**: artists who played together share files.
- Exploring a scene downloads a handful of small files, not hundreds.
- Downloaded index files are kept in the browser (Cache Storage), so revisiting a scene is instant even after a reload.
- Artists missing from the index fall back to the live MusicBrainz API (about one request per second).

```bash
# Build the index locally (~10 min). Dumps are kept in .cache/ (gitignored).
curl -fL -o .cache/dump/artist.tar.xz https://data.metabrainz.org/pub/musicbrainz/data/json-dumps/<LATEST>/artist.tar.xz
# Discogs monthly dump (~11 GB), e.g. discogs_20261101_releases.xml.gz from https://data.discogs.com/
DUMP_NAME=<LATEST> DISCOGS=.cache/dump/discogs_<YYYYMM01>_releases.xml.gz npm run build-index -- .cache/dump/artist.tar.xz
```

**Deploying.** The deploy workflow builds the index weekly from the newest MusicBrainz dump. Discogs refuses downloads from GitHub's servers, so the workflow doesn't download the Discogs dump. It uses a small **Discogs links file** (`discogs-links.tsv.gz`, the extracted pairs) attached to a GitHub release. The file's SHA-256 is committed in `data/discogs-links.sha256`. If the file is missing or doesn't match, the workflow fails and the current site stays up.

To refresh the Discogs data (e.g. every few months):
1. Extract a new links file from a fresh Discogs dump:
   ```bash
   DUMP_NAME=<LATEST> DISCOGS=.cache/dump/discogs_<YYYYMM01>_releases.xml.gz DISCOGS_EXPORT=.cache/dump/discogs-links.tsv.gz npm run build-index -- .cache/dump/artist.tar.xz
   ```
2. Update the hash:
   ```bash
   (cd .cache/dump && shasum -a 256 discogs-links.tsv.gz) > data/discogs-links.sha256
   ```
3. Upload `discogs-links.tsv.gz` to the release tagged `discogs-links`, replacing the old file. Use the GitHub website, or `gh release upload discogs-links .cache/dump/discogs-links.tsv.gz --clobber`.
4. Commit and push the new hash.

The index (about 700 MB) must stay under GitHub Pages' 1 GB site limit.

**Navigating:**
- Two-finger swipe or scroll wheel pans; pinch or Ctrl/⌘ + scroll zooms; drag pans.
- Arrow keys pan, `+`/`-` zoom, `0` fits everything, Esc deselects.

Optionally, a hand-picked graph (`data/graph.json`, built on the local review page) is shown as the starting view.

## Optional: curate a starting graph (local)

```bash
npm install
cp .env.local.example .env.local   # then fill in MB_CONTACT
npm run dev
```

- **Review page:** http://localhost:5173/review.html. Search an artist and check the connections you want. Then save.
  - Unchecked connections are rejected for good.
  - Unchecked albums are skipped and can be added later.
  - "Up next" lists artists in the graph you haven't reviewed yet.
- **Explorer:** http://localhost:5173/. Shows `data/graph.json` live.

Everything you accept goes into `data/graph.json`, the single source of truth. Commit it like any other file.

## Publish

Pushing to `main` builds the explorer and deploys it to GitHub Pages (`.github/workflows/deploy.yml`).
First time only: repo **Settings → Pages → Source: GitHub Actions**.

```bash
npm run build     # export layout + build dist/ (explorer only, no review page)
npm run preview
```

## Scripts

| | |
|---|---|
| `npm run dev` | Review page + explorer, with the local API |
| `npm run export` | `data/graph.json` → `public/graph.export.json` (ForceAtlas2 layout) |
| `npm run build` | export + production build into `dist/` |
| `npm test` | Mapping and store tests against saved MusicBrainz responses |

`GRAPH_PATH=/some/copy.json npm run dev` points the tools at a scratch copy of the graph.

## Layout

- `server/`: MusicBrainz client (rate-limited, cached in `.cache/`), suggestion mapping, graph store, dev API
- `src/review/`: review page
- `src/site/`: public explorer (sigma.js + graphology)
- `src/shared/`: types and styles used by both
