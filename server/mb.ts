// Minimal MusicBrainz client: 1 request/second, disk cache, retry on 503.
// API docs: https://musicbrainz.org/doc/MusicBrainz_API
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE = 'https://musicbrainz.org/ws/2';
const CACHE_DIR = resolve(import.meta.dirname, '../.cache/mb');
const MIN_INTERVAL_MS = 1100;
const DAY = 24 * 60 * 60 * 1000;

// ---- Raw MusicBrainz shapes (only the fields we use) ----

export interface MbLifeSpan {
  begin?: string | null;
  end?: string | null;
  ended?: boolean;
}

export interface MbArtistRef {
  id: string;
  name: string;
  'sort-name': string;
  type?: string | null; // "Person" | "Group" | "Orchestra" | "Choir" | "Character" | "Other"
  disambiguation?: string;
}

export interface MbRelation {
  type: string;
  'target-type': string;
  direction: 'forward' | 'backward';
  begin?: string | null;
  end?: string | null;
  ended?: boolean;
  attributes?: string[];
  artist?: MbArtistRef;
  url?: { resource: string };
}

export interface MbArtist extends MbArtistRef {
  country?: string | null;
  'life-span'?: MbLifeSpan;
  relations?: MbRelation[];
}

export interface MbSearchArtist extends MbArtist {
  score: number;
}

export interface MbReleaseGroup {
  id: string;
  title: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
}

// ---- Client ----

let userAgent = 'sonar/0.1 ( personal project )';
export function setContact(contact: string | undefined) {
  if (contact) userAgent = `sonar/0.1 ( ${contact} )`;
}

let queue: Promise<unknown> = Promise.resolve();
let lastRequest = 0;

/** Serializes network requests so we never exceed MusicBrainz's rate limit. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(path: string, params: Record<string, string>, ttlMs: number, fresh = false): Promise<T> {
  const url = `${BASE}/${path}?${new URLSearchParams({ ...params, fmt: 'json' })}`;
  const cacheFile = resolve(CACHE_DIR, createHash('sha1').update(url).digest('hex') + '.json');

  if (!fresh) {
    try {
      const s = await stat(cacheFile);
      if (Date.now() - s.mtimeMs < ttlMs) return JSON.parse(await readFile(cacheFile, 'utf8')) as T;
    } catch {
      // not cached
    }
  }

  for (let attempt = 0; ; attempt++) {
    const res = await throttled(() => fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } }));
    if (res.status === 503 && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`MusicBrainz ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as T;
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(body));
    return body;
  }
}

export async function searchArtists(query: string): Promise<MbSearchArtist[]> {
  const body = await getJson<{ artists: MbSearchArtist[] }>('artist', { query, limit: '15' }, DAY);
  return body.artists ?? [];
}

export async function lookupArtist(mbid: string, fresh = false): Promise<MbArtist> {
  return getJson<MbArtist>(`artist/${mbid}`, { inc: 'artist-rels+url-rels' }, 30 * DAY, fresh);
}

/** Album release groups (studio albums plus live/compilation, filtered later). */
export async function artistAlbums(mbid: string, fresh = false): Promise<MbReleaseGroup[]> {
  const body = await getJson<{ 'release-groups': MbReleaseGroup[] }>(
    'release-group',
    { artist: mbid, type: 'album', limit: '100' },
    30 * DAY,
    fresh,
  );
  return body['release-groups'] ?? [];
}
