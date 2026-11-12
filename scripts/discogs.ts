// Discogs release credits → "worked together" pairs between MusicBrainz artists.
//
// MusicBrainz is strong on band membership but thin on who played on whose records (especially for
// Japanese music: Ichiko Aoba × Ryuichi Sakamoto, ZUTOMAYO's collaborators…). Discogs' monthly
// release dump (CC0) has those credits. We stream it, keep only *musical* credits, and connect:
//   - main artists of the same release with each other (splits, "A & B", "A feat. B"), and
//   - each main artist with everyone credited for playing/singing/writing/producing on it.
// Only artists that MusicBrainz links to a Discogs page are kept (that's how the two are matched).
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/** Discogs placeholder artists ("Various", "Unknown Artist", "No Artist"…) never count. */
const PLACEHOLDERS = new Set(['194', '355', '118760', '151641']);

/** Releases crediting more distinct artists than this are compilations or big ensembles: skipped. */
const MAX_PEOPLE = 15;
/** More main artists than this = a compilation (track-by-track various artists): skipped. */
const MAX_MAINS = 4;

// Credits that mean making the music together…
const MUSICAL =
  /feat|vocal|voice|chorus|choir|rap|\bmc\b|instrument|guitar|bass|drum|percussion|piano|keyboard|synth|organ|violin|viola|cello|string|horn|trumpet|trombone|tuba|sax|flute|clarinet|oboe|bassoon|harp|accordion|banjo|mandolin|ukulele|turntable|scratch|programm|beats|sampler|electronic|vibraphone|marimba|glockenspiel|harmonica|koto|shamisen|shakuhachi|erhu|sitar|tabla|arrang|produc|compos|written|lyrics|music by|songwriter|conduct|orchestrat|perform|remix|played by|instruments/i;
// …and credits that don't (studio, business, design), even when they contain a musical word.
const NOT_MUSICAL =
  /engineer|master|mixed by|mix engineer|recorded|record by|a&r|manage|design|photo|art direction|artwork|liner|notes|lacquer|\bcut\b|layout|legal|coordinat|executive|edited|transfer|restor|technician|crew|booking|promot|copyright|thanks|graphic|illustrat|typograph|translat|dj mix|compiled|curated|supervis|assistant|tour|merch|cover|sleeve|film|video|director|editor|text|written-by \[liner/i;

export const isMusicalRole = (role: string) => MUSICAL.test(role) && !NOT_MUSICAL.test(role);

/**
 * "Worked together" pairs, stored compactly: tens of millions of pairs don't fit as JS objects
 * (and a single Map tops out at ~16.7M entries). Artists are small integers; each pair's data
 * lives in typed arrays at index `i`; titles are stored once per release.
 */
export class PairTable {
  /** pair key (a * 2^21 + b, a < b) → index, spread over buckets to stay under Map's size limit */
  private buckets = Array.from({ length: 64 }, () => new Map<number, number>());
  size = 0;
  a = new Uint32Array(1 << 20);
  b = new Uint32Array(1 << 20);
  weight = new Uint16Array(1 << 20);
  year = new Uint16Array(1 << 20);
  title = new Uint32Array(1 << 20);
  lastMaster = new Uint32Array(1 << 20);
  titles: string[] = [];

  private grow() {
    const n = this.a.length * 2;
    const g = <T extends Uint32Array | Uint16Array>(old: T, make: (n: number) => T) => {
      const next = make(n);
      next.set(old);
      return next;
    };
    this.a = g(this.a, (n) => new Uint32Array(n));
    this.b = g(this.b, (n) => new Uint32Array(n));
    this.weight = g(this.weight, (n) => new Uint16Array(n));
    this.year = g(this.year, (n) => new Uint16Array(n));
    this.title = g(this.title, (n) => new Uint32Array(n));
    this.lastMaster = g(this.lastMaster, (n) => new Uint32Array(n));
  }

  /** Records one shared release. Editions of the same album (same master) count once. */
  add(x: number, y: number, master: number, titleRef: number, year: number) {
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = a * 2097152 + b;
    const bucket = this.buckets[key % 64];
    const i = bucket.get(key);
    if (i === undefined) {
      if (this.size === this.a.length) this.grow();
      const j = this.size++;
      this.a[j] = a;
      this.b[j] = b;
      this.weight[j] = 1;
      this.year[j] = year;
      this.title[j] = titleRef;
      this.lastMaster[j] = master;
      bucket.set(key, j);
    } else if (this.lastMaster[i] !== master) {
      if (this.weight[i] < 65535) this.weight[i]++;
      this.lastMaster[i] = master;
    }
  }

  /** Records a pair with a known weight (from a links file). Repeats keep the larger weight. */
  put(x: number, y: number, weight: number, titleRef: number, year: number) {
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = a * 2097152 + b;
    const bucket = this.buckets[key % 64];
    const i = bucket.get(key);
    if (i !== undefined) {
      if (weight > this.weight[i]) this.weight[i] = Math.min(weight, 65535);
      return;
    }
    if (this.size === this.a.length) this.grow();
    const j = this.size++;
    this.a[j] = a;
    this.b[j] = b;
    this.weight[j] = Math.min(weight, 65535);
    this.year[j] = year;
    this.title[j] = titleRef;
    bucket.set(key, j);
  }

  has(x: number, y: number) {
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = a * 2097152 + b;
    return this.buckets[key % 64].has(key);
  }
}

interface Credit {
  id: string;
  role: string;
}

/** The `<artist>` entries inside one `<artists>` or `<extraartists>` block. */
function credits(block: string): Credit[] {
  const out: Credit[] = [];
  for (const m of block.matchAll(/<artist>([\s\S]*?)<\/artist>/g)) {
    const id = m[1].match(/<id>(\d+)<\/id>/)?.[1];
    if (!id || PLACEHOLDERS.has(id)) continue;
    const role = m[1].match(/<role>([\s\S]*?)<\/role>/)?.[1] ?? '';
    out.push({ id, role });
  }
  return out;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/**
 * Who worked with whom on one release (Discogs ids), or null if the release is skipped.
 * Exported for tests.
 */
export function releasePairs(xml: string): { pairs: [string, string][]; title: string; year: string; master: string } | null {
  const tracklistAt = xml.indexOf('<tracklist>');
  const head = tracklistAt >= 0 ? xml.slice(0, tracklistAt) : xml;
  const tracks = tracklistAt >= 0 ? xml.slice(tracklistAt) : '';

  // Release-level main artists: the first <artists> block; release-level credits: <extraartists>.
  const mains = new Set(credits(head.match(/<artists>([\s\S]*?)<\/artists>/)?.[1] ?? '').map((c) => c.id));
  const others = new Set<string>();
  for (const c of credits(head.match(/<extraartists>([\s\S]*?)<\/extraartists>/)?.[1] ?? '')) {
    if (isMusicalRole(c.role)) others.add(c.id);
  }
  // Track-level: track artists count as main (featured/split tracks); track credits as others.
  for (const m of tracks.matchAll(/<artists>([\s\S]*?)<\/artists>/g)) for (const c of credits(m[1])) mains.add(c.id);
  for (const m of tracks.matchAll(/<extraartists>([\s\S]*?)<\/extraartists>/g)) {
    for (const c of credits(m[1])) if (isMusicalRole(c.role)) others.add(c.id);
  }
  for (const id of mains) others.delete(id);

  if (!mains.size || mains.size > MAX_MAINS || mains.size + others.size > MAX_PEOPLE) return null;

  const pairs: [string, string][] = [];
  const m = [...mains];
  for (let i = 0; i < m.length; i++) {
    for (let j = i + 1; j < m.length; j++) pairs.push([m[i], m[j]]);
    for (const o of others) pairs.push([m[i], o]);
  }
  if (!pairs.length) return null;
  const title = decode(head.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
  const year = head.match(/<released>(\d{4})/)?.[1] ?? '';
  const master = xml.match(/<master_id[^>]*>(\d+)<\/master_id>/)?.[1] ?? `r${xml.match(/<release id="(\d+)"/)?.[1] ?? ''}`;
  return { pairs, title, year, master };
}

/**
 * Streams the Discogs releases dump and fills a PairTable of "worked together" pairs between
 * MusicBrainz artists. `toArtist` maps Discogs artist id → our integer artist number (only artists
 * MusicBrainz links to Discogs have one).
 */
export async function readDiscogsPairs(
  file: string,
  toArtist: Map<string, number>,
  log: (msg: string) => void,
): Promise<PairTable> {
  const table = new PairTable();
  let releases = 0;
  let used = 0;
  // Split on raw bytes, decoding each release into its own string. (Slicing one big growing string
  // instead makes V8 keep every earlier chunk alive behind the small leftover slices: out of memory.)
  const END = Buffer.from('</release>');
  const START = Buffer.from('<release ');
  let rest = Buffer.alloc(0);
  const stream = createReadStream(file, { highWaterMark: 1 << 22 }).pipe(createGunzip({ chunkSize: 1 << 22 }));
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let from = 0;
    let end: number;
    while ((end = buf.indexOf(END, from)) >= 0) {
      const start = buf.indexOf(START, from);
      const xml = start >= 0 && start < end ? buf.toString('utf8', start, end) : '';
      from = end + END.length;
      if (++releases % 1_000_000 === 0) {
        const heap = (process.memoryUsage().heapUsed / 1e9).toFixed(1);
        log(`Discogs: ${releases.toLocaleString()} releases read, ${table.size.toLocaleString()} pairs, heap ${heap} GB`);
      }
      if (!xml) continue;
      const r = releasePairs(xml);
      if (!r) continue;
      const master = Number(r.master.replace(/^r/, '')) + (r.master.startsWith('r') ? 2 ** 31 : 0);
      let titleRef = -1;
      for (const [x, y] of r.pairs) {
        const a = toArtist.get(x);
        const b = toArtist.get(y);
        if (a === undefined || b === undefined || a === b) continue;
        if (titleRef < 0) {
          titleRef = table.titles.length;
          // A real copy: a substring would keep this whole release's XML alive.
          table.titles.push(Buffer.from(r.title, 'utf8').toString('utf8'));
        }
        table.add(a, b, master >>> 0, titleRef, Number(r.year) || 0);
      }
      if (titleRef >= 0) used++;
    }
    rest = Buffer.from(buf.subarray(from)); // a copy of just the unfinished release
  }
  log(`Discogs: ${releases.toLocaleString()} releases, ${used.toLocaleString()} with matched collaborators, ${table.size.toLocaleString()} pairs.`);
  return table;
}

// ---- Discogs links file ----
// The releases dump is ~11 GB and Discogs refuses downloads from CI, so the pairs are extracted
// once, locally, into a small gzipped TSV: `discogsA \t discogsB \t weight \t year \t title`.
// Keyed by Discogs artist ids, so each build maps them through the *current* MusicBrainz dump.

// Tabs and anything a line reader may treat as a line break (old titles contain U+2028).
const clean = (s: string) => s.replace(/[\t\n\v\f\r\x85\u2028\u2029]+/g, ' ');

/** Writes the pairs of `t` as a links file. `discogsOf[n]` is a Discogs id for artist number n. */
export async function writeLinksFile(t: PairTable, discogsOf: string[], file: string, log: (msg: string) => void) {
  const gz = createGzip({ level: 9 });
  const out = gz.pipe(createWriteStream(file));
  let chunk = '';
  for (let i = 0; i < t.size; i++) {
    chunk += `${discogsOf[t.a[i]]}\t${discogsOf[t.b[i]]}\t${t.weight[i]}\t${t.year[i] || ''}\t${clean(t.titles[t.title[i]] ?? '')}\n`;
    if (chunk.length > 1 << 20) {
      if (!gz.write(chunk)) await once(gz, 'drain');
      chunk = '';
    }
  }
  gz.end(chunk);
  await finished(out);
  log(`Discogs: wrote ${t.size.toLocaleString()} pairs to ${file}.`);
}

/** Reads a links file into a PairTable of our artist numbers (pairs with an unknown side are skipped). */
export async function readLinksFile(file: string, toArtist: Map<string, number>, log: (msg: string) => void): Promise<PairTable> {
  const t = new PairTable();
  let lines = 0;
  let lastTitle: string | undefined;
  const lineReader = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lineReader) {
    if (!line) continue;
    lines++;
    const [x, y, weight, year, title = ''] = line.split('\t');
    const a = toArtist.get(x);
    const b = toArtist.get(y);
    if (a === undefined || b === undefined || a === b) continue;
    if (title !== lastTitle) {
      t.titles.push(title); // pairs of one release are consecutive: one title string each
      lastTitle = title;
    }
    t.put(a, b, Number(weight) || 1, t.titles.length - 1, Number(year) || 0);
  }
  log(`Discogs: ${lines.toLocaleString()} pairs in ${file}, ${t.size.toLocaleString()} between artists in this dump.`);
  return t;
}
