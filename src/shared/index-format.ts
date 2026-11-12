// Format of the prebuilt connection index (public/index/), shared by the builder and the site.
//
// public/index/meta.json          → IndexMeta
// public/index/shards/<id>.json.gz → Record<mbid, IndexArtist>: one *neighborhood* per file. Artists
//                                   are grouped by community (who played with whom), so a band, its
//                                   members and their other bands mostly sit in the same few files.
// public/index/dir/<abc>.json.gz  → Record<mbid, shardId>, keyed by the first 3 hex chars of the
//                                   MBID: only needed for the first lookup (a search result or a
//                                   shared link). After that, every connection carries a hint
//                                   saying which shard the other artist is in.
//
// Arrays instead of objects keep the files small (the index covers hundreds of thousands of artists).
import type { ArtistKind, EdgeType } from './types.ts';

/** Bump when the on-disk format changes (the deploy cache key and the site check this). */
export const INDEX_FORMAT = 4;

export const DIR_CHARS = 3;
export const dirOf = (mbid: string) => mbid.slice(0, DIR_CHARS);

export interface IndexMeta {
  format: number;
  /** MusicBrainz dump the index was built from, e.g. "20261107-001001" */
  dump: string;
  builtAt: string;
  artists: number;
  edges: number;
  shards: number;
}

export const EDGE_CODE: Record<Exclude<EdgeType, 'released'>, string> = {
  member_of: 'm',
  collaborated: 'c',
  supporting: 's',
  subgroup_of: 'g',
  founded: 'f',
  worked_with: 'w',
};
export const EDGE_FROM_CODE = Object.fromEntries(Object.entries(EDGE_CODE).map(([k, v]) => [v, k])) as Record<
  string,
  Exclude<EdgeType, 'released'>
>;

export const KIND_CODE = { person: 'p', group: 'g' } as const satisfies Record<ArtistKind, string>;

/**
 * One connection, from the indexed artist's point of view:
 * [edge code, 1 if this artist is the edge source else 0, other id, other name, other kind code,
 *  begin, end, attributes]  (trailing empty fields are dropped)
 */
export type IndexLink = [string, 0 | 1, string, string, 'p' | 'g', string?, string?, string[]?];

export interface IndexArtist {
  /** name */
  n: string;
  /** kind code */
  k: 'p' | 'g';
  /** country */
  c?: string;
  /** life span begin / end */
  b?: string;
  e?: string;
  /** disambiguation */
  d?: string;
  /** Wikidata Q-id */
  w?: string;
  /** connections */
  r: IndexLink[];
  /** For each connection in `r`, the shard the other artist lives in ("" if not indexed) */
  h: string[];
}
