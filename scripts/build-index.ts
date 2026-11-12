// Builds the static connection index from a MusicBrainz JSON dump.
//
//   npm run build-index -- .cache/dump/artist.tar.xz
//
// 1. Streams the archive (17+ GB uncompressed) through xz and tar without unpacking it to disk,
//    keeping only artist↔artist connections we show (band membership, collaborations,
//    supporting musicians, founders, subgroups).
// 2. Groups artists into neighborhoods (community detection over the whole graph) and packs each
//    neighborhood into the same shard files, so exploring a scene downloads a few files instead of
//    hundreds (see src/shared/index-format.ts).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { basename, dirname, resolve } from 'node:path';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { MbArtist } from '../server/mb.ts';
import { mergeEdge, relationToEdge, toArtist, toStub } from '../server/suggest.ts';
import {
  dirOf,
  EDGE_CODE,
  INDEX_FORMAT,
  KIND_CODE,
  type IndexArtist,
  type IndexLink,
  type IndexMeta,
} from '../src/shared/index-format.ts';
import type { Edge } from '../src/shared/types.ts';
import { type PairTable, readDiscogsPairs, readLinksFile, writeLinksFile } from './discogs.ts';

const archive = resolve(process.argv[2] ?? '.cache/dump/artist.tar.xz');
/** Optional Discogs releases dump (discogs_YYYYMMDD_releases.xml.gz) for "worked together" credits. */
/**
 * DISCOGS: either the Discogs releases dump (discogs_*_releases.xml.gz) or a links file extracted
 * from it (*.tsv.gz, see scripts/discogs.ts). DISCOGS_EXPORT: also write the links file here.
 */
const discogsFile = process.env.DISCOGS ? resolve(process.env.DISCOGS) : null;
const discogsExport = process.env.DISCOGS_EXPORT ? resolve(process.env.DISCOGS_EXPORT) : null;
/**
 * Every Discogs pair is kept by default. Optional trimming (0 = off): DISCOGS_PER_ARTIST keeps only
 * pairs among either side's top N collaborators (most shared releases); DISCOGS_MAX caps any
 * artist's total. Trimming cuts real links (a cap of 40 dropped Ryuichi Sakamoto × Ichiko Aoba).
 */
const DISCOGS_PER_ARTIST = Number(process.env.DISCOGS_PER_ARTIST ?? 0) || Infinity;
const DISCOGS_MAX = Number(process.env.DISCOGS_MAX ?? 0) || Infinity;
const DISCOGS_LINK = 'www.discogs.com/artist/';
const outDir = resolve(process.env.OUT_DIR ?? resolve(import.meta.dirname, '../public/index'));
// The dump folder name (e.g. 20261107-001001) if the archive sits in one; otherwise "unknown".
const dumpName =
  process.env.DUMP_NAME ?? (/^\d{8}-\d{6}$/.test(basename(dirname(archive))) ? basename(dirname(archive)) : 'unknown');

/**
 * Target shard size (raw JSON). Measured on real growths (~1,500 artists): 16 KB shards download
 * ~1.0 MB vs 2.2 MB at 48 KB (and 6–9 MB with the old random-by-ID files) for a similar number
 * of requests, because small neighborhood files carry less you don't need.
 */
const SHARD_BYTES = Number(process.env.SHARD_BYTES ?? 16_000);
/** Louvain resolution: lower = bigger neighborhoods. */
const RESOLUTION = Number(process.env.RESOLUTION ?? 1);

const ARTIST_REL = '"target-type":"artist"';
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);
const t0 = Date.now();

type Rec = Omit<IndexArtist, 'h'>;

/** MusicBrainz artists' Discogs ids, and basic info for artists that only Discogs connects. */
const discogsToMb = new Map<string, string>();
const stubs = new Map<string, Rec>();

function stubRecord(mb: MbArtist): Rec {
  const a = toArtist(mb);
  const rec: Rec = { n: a.name, k: KIND_CODE[a.kind], r: [] };
  if (a.country) rec.c = a.country;
  if (a.begin) rec.b = a.begin;
  if (a.end) rec.e = a.end;
  if (a.disambiguation) rec.d = a.disambiguation;
  if (a.wikidata) rec.w = a.wikidata;
  return rec;
}

async function readDump(): Promise<Map<string, Rec>> {
  const xz = spawn('xz', ['-T0', '-dc', archive], { stdio: ['ignore', 'pipe', 'inherit'] });
  const tar = spawn('tar', ['-xOf', '-', 'mbdump/artist'], { stdio: ['pipe', 'pipe', 'inherit'] });
  xz.stdout.pipe(tar.stdin);
  // tar exits as soon as it has extracted mbdump/artist, while xz may still be writing the rest of
  // the archive: that broken pipe is expected, not an error.
  tar.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
  xz.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });

  const records = new Map<string, Rec>();
  let lines = 0;
  const rl = createInterface({ input: tar.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (++lines % 500_000 === 0) log(`${lines.toLocaleString()} artists read, ${records.size.toLocaleString()} kept`);
    // Cheap pre-filter: most lines have no artist↔artist relations (or Discogs link) at all.
    const hasDiscogs = discogsFile !== null && line.includes(DISCOGS_LINK);
    if (!line.includes(ARTIST_REL) && !hasDiscogs) continue;
    let mb: MbArtist;
    try {
      mb = JSON.parse(line) as MbArtist;
    } catch {
      continue;
    }
    if (hasDiscogs) {
      for (const rel of mb.relations ?? []) {
        const id = rel.type === 'discogs' ? rel.url?.resource.match(/artist\/(\d+)/)?.[1] : undefined;
        if (id) discogsToMb.set(id, mb.id);
      }
    }
    const edges = new Map<string, { edge: Edge; other: ReturnType<typeof toStub> }>();
    for (const rel of mb.relations ?? []) {
      const edge = relationToEdge(mb.id, rel);
      if (!edge || !rel.artist || edge.source === edge.target) continue;
      const prev = edges.get(edge.id);
      edges.set(edge.id, { edge: prev ? mergeEdge(prev.edge, edge) : edge, other: toStub(rel.artist) });
    }
    if (!edges.size) {
      // No MusicBrainz connections, but Discogs may connect them later.
      if (hasDiscogs) stubs.set(mb.id, stubRecord(mb));
      continue;
    }

    const a = toArtist(mb);
    const r: IndexLink[] = [];
    for (const { edge, other } of edges.values()) {
      const link: IndexLink = [
        EDGE_CODE[edge.type as keyof typeof EDGE_CODE],
        edge.source === mb.id ? 1 : 0,
        other.id,
        other.name,
        KIND_CODE[other.kind],
        edge.begin ?? '',
        edge.end ?? '',
        edge.attributes ?? [],
      ];
      while (link.length > 5) {
        const last = link[link.length - 1];
        if (last === '' || (Array.isArray(last) && !last.length)) link.pop();
        else break;
      }
      r.push(link);
    }
    const rec: Rec = { n: a.name, k: KIND_CODE[a.kind], r };
    if (a.country) rec.c = a.country;
    if (a.begin) rec.b = a.begin;
    if (a.end) rec.e = a.end;
    if (a.disambiguation) rec.d = a.disambiguation;
    if (a.wikidata) rec.w = a.wikidata;
    records.set(mb.id, rec);
  }
  const [xzCode, tarCode] = await Promise.all([exitCode(xz), exitCode(tar)]);
  // tar decides: xz may be cut off (broken pipe / SIGPIPE) once tar has what it needs.
  if (tarCode !== 0) throw new Error(`tar exited ${tarCode} (xz exited ${xzCode})`);
  if (!records.size) throw new Error('No artists with connections found: is this the artist dump?');
  log(`Read ${lines.toLocaleString()} artists; ${records.size.toLocaleString()} have connections.`);
  return records;
}

/**
 * Assigns every artist a shard so that neighbors share shards:
 * - community detection (Louvain) over the whole who-played-with-whom graph;
 * - a community that's too big for one shard is cut into pieces along breadth-first order from its
 *   best-connected artist (so each piece is a connected neighborhood);
 * - small communities are packed together whole.
 */
function assignShards(records: Map<string, Rec>): Map<string, string> {
  const g = new Graph({ type: 'undirected' });
  for (const id of records.keys()) g.addNode(id);
  for (const [id, rec] of records) {
    for (const l of rec.r) if (records.has(l[2]) && id < l[2] && !g.hasEdge(id, l[2])) g.addEdge(id, l[2]);
  }
  log(`Graph: ${g.order.toLocaleString()} artists, ${g.size.toLocaleString()} connections. Finding neighborhoods…`);
  const community = louvain(g, { resolution: RESOLUTION }) as Record<string, number>;

  const members = new Map<number, string[]>();
  for (const [id, c] of Object.entries(community)) {
    if (!members.has(c)) members.set(c, []);
    members.get(c)!.push(id);
  }
  log(`${members.size.toLocaleString()} neighborhoods. Packing into shards…`);

  const size = (id: string) => JSON.stringify(records.get(id)).length + 40;
  const shardOf = new Map<string, string>();
  let next = 0;
  const newShard = () => (next++).toString(36);

  // Big neighborhoods: cut along BFS order so each shard is a connected piece.
  const small: string[][] = [];
  for (const ids of [...members.values()].sort((a, b) => b.length - a.length)) {
    const bytes = ids.reduce((a, id) => a + size(id), 0);
    if (bytes <= SHARD_BYTES * 1.5) {
      small.push(ids);
      continue;
    }
    const inCommunity = new Set(ids);
    const seen = new Set<string>();
    const order: string[] = [];
    // Start from the best-connected artist; repeat for any parts not reached.
    const starts = [...ids].sort((a, b) => g.degree(b) - g.degree(a));
    for (const start of starts) {
      if (seen.has(start)) continue;
      const queue = [start];
      seen.add(start);
      while (queue.length) {
        const id = queue.shift()!;
        order.push(id);
        for (const n of g.neighbors(id)) {
          if (inCommunity.has(n) && !seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
    }
    let shard = newShard();
    let filled = 0;
    for (const id of order) {
      const s = size(id);
      if (filled > 0 && filled + s > SHARD_BYTES) {
        shard = newShard();
        filled = 0;
      }
      shardOf.set(id, shard);
      filled += s;
    }
  }

  // Small neighborhoods: packed together whole, biggest first.
  let shard = newShard();
  let filled = 0;
  for (const ids of small) {
    const bytes = ids.reduce((a, id) => a + size(id), 0);
    if (filled > 0 && filled + bytes > SHARD_BYTES) {
      shard = newShard();
      filled = 0;
    }
    for (const id of ids) shardOf.set(id, shard);
    filled += bytes;
  }
  log(`${next.toLocaleString()} shards.`);
  return shardOf;
}

/**
 * Adds Discogs "worked together" connections. Each artist keeps its strongest collaborators
 * (most shared releases); a connection is kept if it's among the top for either side. Pairs already
 * connected through MusicBrainz are skipped (that link says more).
 */
async function addDiscogs(records: Map<string, Rec>) {
  if (!discogsFile) return;
  // Integer numbers for every artist MusicBrainz links to Discogs (compact pair storage).
  const ids: string[] = [];
  const num = new Map<string, number>();
  const toArtist = new Map<string, number>();
  const discogsOf: string[] = [];
  for (const [dg, mb] of discogsToMb) {
    let n = num.get(mb);
    if (n === undefined) {
      n = ids.length;
      ids.push(mb);
      num.set(mb, n);
      discogsOf[n] = dg;
    }
    toArtist.set(dg, n);
  }
  // Pair keys pack two artist numbers into one (a * 2^21 + b): stop loudly rather than mix pairs up.
  if (ids.length >= 2 ** 21) throw new Error(`Too many Discogs-linked artists for pair keys: ${ids.length}`);
  log(`Discogs: ${ids.length.toLocaleString()} MusicBrainz artists link to Discogs. Reading credits…`);
  const t = discogsFile.endsWith('.tsv.gz')
    ? await readLinksFile(discogsFile, toArtist, log)
    : await readDiscogsPairs(discogsFile, toArtist, log);
  if (discogsExport) await writeLinksFile(t, discogsOf, discogsExport, log);

  const keep = DISCOGS_PER_ARTIST === Infinity && DISCOGS_MAX === Infinity ? allPairs(t.size) : trimPairs(t);
  log(`Discogs: keeping ${keep.size.toLocaleString()} of ${t.size.toLocaleString()} pairs.`);
  addPairs(records, ids, t, keep);
}

const allPairs = (n: number) => ({ size: n, *[Symbol.iterator]() { for (let i = 0; i < n; i++) yield i; } });

/** Optional trimming (DISCOGS_PER_ARTIST / DISCOGS_MAX): the pair indices to keep. */
function trimPairs(t: PairTable): Set<number> {
  // Each artist's strongest collaborators: a small "top N" buffer per artist (pair indices).
  const top = new Map<number, number[]>();
  const offer = (artist: number, i: number) => {
    let list = top.get(artist);
    if (!list) top.set(artist, (list = []));
    if (list.length < DISCOGS_PER_ARTIST) return void list.push(i);
    let min = 0;
    for (let k = 1; k < list.length; k++) if (t.weight[list[k]] < t.weight[list[min]]) min = k;
    if (t.weight[i] > t.weight[list[min]]) list[min] = i;
  };
  for (let i = 0; i < t.size; i++) {
    offer(t.a[i], i);
    offer(t.b[i], i);
  }
  const nominated = new Set<number>();
  for (const list of top.values()) for (const i of list) nominated.add(i);
  // Cap every artist's total: strongest pairs first; a pair is kept only if both sides have room.
  const order = [...nominated].sort((x, y) => t.weight[y] - t.weight[x]);
  const count = new Map<number, number>();
  const keep = new Set<number>();
  for (const i of order) {
    const ca = count.get(t.a[i]) ?? 0;
    const cb = count.get(t.b[i]) ?? 0;
    if (ca >= DISCOGS_MAX || cb >= DISCOGS_MAX) continue;
    count.set(t.a[i], ca + 1);
    count.set(t.b[i], cb + 1);
    keep.add(i);
  }
  return keep;
}

function addPairs(records: Map<string, Rec>, ids: string[], t: PairTable, keep: Iterable<number>) {
  const recordFor = (id: string) => records.get(id) ?? stubs.get(id);
  let added = 0;
  let viaMusicBrainz = 0;
  let unknown = 0;
  for (const i of keep) {
    const a = ids[t.a[i]];
    const b = ids[t.b[i]];
    const ra = recordFor(a);
    const rb = recordFor(b);
    if (!ra || !rb) {
      unknown++;
      continue;
    }
    if (ra.r.some((l) => l[2] === b)) {
      viaMusicBrainz++; // already connected through MusicBrainz (that link says more)
      continue;
    }
    if (!records.has(a)) records.set(a, ra);
    if (!records.has(b)) records.set(b, rb);
    const title = t.titles[t.title[i]] ?? '';
    const year = t.year[i] ? String(t.year[i]) : '';
    const link = (other: string, rec: Rec, isSource: 0 | 1): IndexLink => {
      const l: IndexLink = [EDGE_CODE.worked_with, isSource, other, rec.n, rec.k, year, '', title ? [title] : []];
      while (l.length > 5) {
        const last = l[l.length - 1];
        if (last === '' || (Array.isArray(last) && !last.length)) l.pop();
        else break;
      }
      return l;
    };
    ra.r.push(link(b, rb, 1));
    rb.r.push(link(a, ra, 0));
    added++;
  }
  log(
    `Discogs: added ${added.toLocaleString()} "worked together" connections, ` +
      `${viaMusicBrainz.toLocaleString()} already linked by MusicBrainz, ${unknown.toLocaleString()} without an artist record; ` +
      `${records.size.toLocaleString()} artists now connected.`,
  );
}

async function main() {
  const records = await readDump();
  await addDiscogs(records);
  const shardOf = assignShards(records);

  // Group records by shard, adding a hint for every connection: where the other artist lives.
  const shards = new Map<string, Record<string, IndexArtist>>();
  const dirs = new Map<string, Record<string, string>>();
  let links = 0;
  for (const [id, rec] of records) {
    const s = shardOf.get(id)!;
    const full: IndexArtist = { ...rec, h: rec.r.map((l) => shardOf.get(l[2]) ?? '') };
    links += rec.r.length;
    if (!shards.has(s)) shards.set(s, {});
    shards.get(s)![id] = full;
    const d = dirOf(id);
    if (!dirs.has(d)) dirs.set(d, {});
    dirs.get(d)![id] = s;
  }

  log(`Writing ${shards.size.toLocaleString()} shards and ${dirs.size.toLocaleString()} directory files…`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(resolve(outDir, 'shards'), { recursive: true });
  await mkdir(resolve(outDir, 'dir'), { recursive: true });
  // Gzipped on disk: GitHub Pages caps a site at 1 GB, and the JSON compresses ~5x.
  const gz = (data: unknown) => gzipSync(JSON.stringify(data), { level: 9 });
  let bytes = 0;
  for (const [s, data] of shards) {
    const file = gz(data);
    bytes += file.length;
    await writeFile(resolve(outDir, 'shards', `${s}.json.gz`), file);
  }
  for (const [d, data] of dirs) {
    const file = gz(data);
    bytes += file.length;
    await writeFile(resolve(outDir, 'dir', `${d}.json.gz`), file);
  }

  const meta: IndexMeta = {
    format: INDEX_FORMAT,
    dump: dumpName,
    builtAt: new Date().toISOString(),
    artists: records.size,
    edges: Math.round(links / 2), // each connection is stored on both artists
    shards: shards.size,
  };
  await writeFile(resolve(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  log(
    `Done: ${records.size.toLocaleString()} artists, ~${meta.edges.toLocaleString()} connections, ` +
      `${(bytes / 1e6).toFixed(0)} MB in ${shards.size.toLocaleString()} shards.`,
  );
}

function exitCode(p: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((res) => (p.exitCode !== null ? res(p.exitCode) : p.on('close', res)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
