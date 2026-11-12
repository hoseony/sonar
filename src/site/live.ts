// Browser-side MusicBrainz client for the live explorer.
// MusicBrainz allows CORS; browsers can't set User-Agent, so MB identifies us by Origin.
// Rate limit: ~1 request/second per visitor, so requests are queued.
import type { MbArtist, MbReleaseGroup, MbSearchArtist } from '../../server/mb.ts';
import { isStudioAlbum, mergeEdge, relationToEdge, toArtist, toStub } from '../../server/suggest.ts';
import { dirOf, EDGE_FROM_CODE, INDEX_FORMAT, type IndexArtist, type IndexMeta } from '../shared/index-format.ts';
import { edgeId, type Artist, type ArtistStub, type Edge } from '../shared/types.ts';

const BASE = 'https://musicbrainz.org/ws/2';
const MIN_INTERVAL_MS = 1100;

let queue: Promise<unknown> = Promise.resolve();
let last = 0;
const cache = new Map<string, Promise<unknown>>();

function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}/${path}?${new URLSearchParams({ ...params, fmt: 'json' })}`;
  const hit = cache.get(url);
  if (hit) return hit as Promise<T>;

  const run = queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 503 && attempt < 3) continue; // rate limited: wait and retry
      if (!res.ok) throw new Error(`MusicBrainz returned ${res.status}`);
      return (await res.json()) as T;
    }
  });
  queue = run.catch(() => undefined);
  cache.set(url, run);
  run.catch(() => cache.delete(url)); // don't cache failures
  return run;
}

export interface SearchResult extends ArtistStub {
  sub: string;
}

export async function searchArtists(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const body = await get<{ artists: MbSearchArtist[] }>('artist', { query, limit: '8' });
  if (signal?.aborted) return [];
  return (body.artists ?? [])
    .filter((a) => a.score >= 50)
    .map((a) => ({
      ...toStub(a),
      sub: [a.disambiguation, a.country, a['life-span']?.begin?.slice(0, 4)].filter(Boolean).join(' · '),
    }));
}

export interface Connections {
  artist: Artist;
  neighbors: ArtistStub[];
  edges: Edge[];
  /** where the data came from: the prebuilt index or a live MusicBrainz request */
  source: 'index' | 'live';
}

// ---------- Prebuilt index (instant, no rate limit) ----------

let metaPromise: Promise<IndexMeta | null> | null = null;
const shardCache = new Map<string, Promise<Record<string, IndexArtist>>>();
const dirCache = new Map<string, Promise<Record<string, string>>>();
/** Which shard each artist lives in, as far as we know. "" means "not in the index". */
const hints = new Map<string, string>();

const indexUrl = (path: string) => `${import.meta.env.BASE_URL}index/${path}`;

/** The index's meta, or null when there's no index or it's in a format this build can't read. */
export function indexMeta(): Promise<IndexMeta | null> {
  // no-cache: always revalidate, so a new deploy (new index) is noticed right away
  if (!metaPromise) {
    metaPromise = fetch(indexUrl('meta.json'), { cache: 'no-cache' })
      .then((r) => (r.ok ? (r.json() as Promise<IndexMeta>) : null))
      .then((m) => (m?.format === INDEX_FORMAT ? m : null))
      .catch(() => null);
    void metaPromise.then((m) => m && openCache()); // drops caches of older builds at startup
  }
  return metaPromise;
}

// ---------- Offline cache (Cache Storage) ----------
// Shard and dir files are immutable for a given build, so they're kept across reloads. The cache
// name includes the build, so a rebuilt index never serves stale files, and old builds are dropped.

const CACHE_PREFIX = 'sonar-index-';
let cachePromise: Promise<Cache | null> | null = null;

function openCache(): Promise<Cache | null> {
  cachePromise ??= (async () => {
    const meta = await indexMeta();
    if (!meta) return null;
    try {
      const name = `${CACHE_PREFIX}${meta.format}-${meta.dump}-${meta.builtAt}`;
      // Unavailable in some private modes and on insecure origins: then we just use fetch.
      const keys = await caches.keys();
      for (const k of keys) if (k.startsWith(CACHE_PREFIX) && k !== name) caches.delete(k).catch(() => undefined);
      return await caches.open(name);
    } catch {
      return null;
    }
  })();
  return cachePromise;
}

/**
 * One index file as JSON, from Cache Storage if we have it, else downloaded (and stored).
 * null for a 404; network errors reject.
 */
async function indexFile<T>(path: string): Promise<T | null> {
  const url = indexUrl(path);
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return await parseIndex<T>(hit);
    } catch {
      // a broken cache entry: fall through to the network
    }
  }
  return limited(async () => {
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Index file ${path}: HTTP ${r.status}`);
    if (cache) cache.put(url, r.clone()).catch(() => undefined); // best effort (e.g. quota)
    return await parseIndex<T>(r);
  });
}

/**
 * Index files are stored gzipped. Decompress here, unless the server already did (one that sends
 * `Content-Encoding: gzip` for .gz files hands us plain JSON): check for the gzip magic bytes.
 */
async function parseIndex<T>(r: Response): Promise<T> {
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(bytes)) as T;
  const plain = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(plain).text()) as T;
}

// At most this many index downloads at once. Firing thousands together (a big frontier)
// makes the browser refuse requests.
const MAX_PARALLEL = 24;
let active = 0;
const waiting: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export const indexStats = () => ({ active, waiting: waiting.length, cached: shardCache.size });

/** A shard's artists. A 404 means the shard is empty; network errors reject (and can be retried). */
function loadShard(id: string): Promise<Record<string, IndexArtist>> {
  let p = shardCache.get(id);
  if (!p) {
    p = indexFile<Record<string, IndexArtist>>(`shards/${id}.json.gz`).then((artists) => {
      artists ??= {};
      // Remember where everything in (and next to) this shard lives, so following a
      // connection never needs a directory lookup.
      for (const [mbid, rec] of Object.entries(artists)) {
        hints.set(mbid, id);
        rec.r.forEach((link, i) => {
          const h = rec.h?.[i];
          if (h !== undefined && !hints.get(link[2])) hints.set(link[2], h);
        });
      }
      return artists;
    });
    p.catch(() => shardCache.delete(id)); // allow a retry later
    shardCache.set(id, p);
  }
  return p;
}

/** A directory file (mbid → shard id). A 404 means none of those artists are indexed. */
function loadDir(prefix: string): Promise<Record<string, string>> {
  let p = dirCache.get(prefix);
  if (!p) {
    p = indexFile<Record<string, string>>(`dir/${prefix}.json.gz`).then((d) => d ?? {});
    p.catch(() => dirCache.delete(prefix));
    dirCache.set(prefix, p);
  }
  return p;
}

/** The shard an artist lives in, or null if it isn't indexed. Hints first, the directory otherwise. */
async function shardFor(mbid: string): Promise<string | null> {
  if (!hints.has(mbid)) hints.set(mbid, (await loadDir(dirOf(mbid)))[mbid] ?? '');
  return hints.get(mbid) || null;
}

/** The artist's index record; undefined if it isn't indexed. Network errors reject. */
async function indexRecord(mbid: string): Promise<IndexArtist | undefined> {
  const shard = await shardFor(mbid);
  return shard ? (await loadShard(shard))[mbid] : undefined;
}

/**
 * Queues downloads for these artists' shards (cached, at most a few at a time). Only artists we
 * already have a hint for: a directory lookup per artist would cost more than it saves.
 */
export async function prefetch(ids: string[]) {
  if (!(await indexMeta())) return;
  const shards = new Set<string>();
  for (const id of ids) {
    const h = hints.get(id);
    if (h) shards.add(h);
  }
  for (const s of shards) loadShard(s).catch(() => undefined);
}

/**
 * How many connections an artist has, without loading them onto the map (for "+14" badges and
 * the hover card). null when there's no index to ask.
 */
export async function connectionCount(mbid: string): Promise<number | null> {
  if (!(await indexMeta())) return null;
  try {
    return (await indexRecord(mbid))?.r.length ?? 0;
  } catch {
    return null;
  }
}

async function fromIndex(mbid: string): Promise<Connections | null> {
  if (!(await indexMeta())) return null;
  // Throws on network errors so the caller marks the artist failed instead of "no connections".
  const rec = await indexRecord(mbid);
  if (!rec) return null;
  const kind = (k: 'p' | 'g') => (k === 'p' ? 'person' : 'group') as Artist['kind'];
  const neighbors: ArtistStub[] = [];
  const edges: Edge[] = [];
  for (const [code, isSource, otherId, otherName, otherKind, begin, end, attrs] of rec.r) {
    const type = EDGE_FROM_CODE[code];
    if (!type) continue;
    const [source, target] = isSource ? [mbid, otherId] : [otherId, mbid];
    edges.push({
      id: edgeId(type, source, target),
      type,
      source,
      target,
      begin: begin || undefined,
      end: end || undefined,
      attributes: attrs?.length ? attrs : undefined,
    });
    neighbors.push({ id: otherId, name: otherName, sortName: otherName, kind: kind(otherKind) });
  }
  const artist: Artist = {
    id: mbid,
    name: rec.n,
    sortName: rec.n,
    kind: kind(rec.k),
    country: rec.c,
    begin: rec.b,
    end: rec.e,
    disambiguation: rec.d,
    wikidata: rec.w,
  };
  return { artist, neighbors, edges, source: 'index' };
}

/**
 * The artist plus every artist it's directly connected to: from the prebuilt index when the
 * artist is in it (instant), otherwise one live MusicBrainz request (rate-limited).
 */
export async function fetchConnections(mbid: string): Promise<Connections>;
export async function fetchConnections(mbid: string, opts: { indexOnly: true }): Promise<Connections | null>;
export async function fetchConnections(mbid: string, opts?: { indexOnly?: boolean }): Promise<Connections | null> {
  const hit = await fromIndex(mbid);
  if (hit) return hit;
  // Deep, automatic exploration only uses the index: an artist missing from it has no
  // connections as of the dump, so a slow live request would add nothing.
  if (opts?.indexOnly && (await indexMeta())) return null;
  return fetchLive(mbid);
}

async function fetchLive(mbid: string): Promise<Connections> {
  const mb = await get<MbArtist>(`artist/${mbid}`, { inc: 'artist-rels+url-rels' });
  const edges = new Map<string, Edge>();
  const neighbors = new Map<string, ArtistStub>();
  for (const rel of mb.relations ?? []) {
    const edge = relationToEdge(mb.id, rel);
    if (!edge || !rel.artist || edge.source === edge.target) continue;
    const prev = edges.get(edge.id);
    edges.set(edge.id, prev ? mergeEdge(prev, edge) : edge);
    neighbors.set(rel.artist.id, toStub(rel.artist));
  }
  return { artist: toArtist(mb), neighbors: [...neighbors.values()], edges: [...edges.values()], source: 'live' };
}

export interface AlbumInfo {
  id: string;
  title: string;
  year?: string;
}

export async function fetchAlbums(mbid: string): Promise<AlbumInfo[]> {
  const body = await get<{ 'release-groups': MbReleaseGroup[] }>('release-group', {
    artist: mbid,
    type: 'album',
    limit: '100',
  });
  return (body['release-groups'] ?? [])
    .filter(isStudioAlbum)
    .map((rg) => ({ id: rg.id, title: rg.title, year: rg['first-release-date']?.slice(0, 4) || undefined }))
    .sort((a, b) => (a.year ?? '9999').localeCompare(b.year ?? '9999'));
}
