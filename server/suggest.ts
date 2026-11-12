// Turns raw MusicBrainz data into reviewable suggestions. Pure functions only.
import type { MbArtist, MbArtistRef, MbRelation, MbReleaseGroup } from './mb.ts';
import {
  edgeId,
  type Album,
  type Artist,
  type ArtistKind,
  type ArtistStub,
  type Edge,
  type EdgeType,
  type GraphData,
  type Suggestion,
  type SuggestResponse,
} from '../src/shared/types.ts';

/**
 * MusicBrainz artist→artist relationship types we care about.
 * `entity0IsSource` says which side becomes the edge source: for "member of band",
 * entity0 is the person and entity1 the band, so person → band.
 * Personal relations (married, sibling, parent…) and trivia (tribute, named after) are left out.
 */
const REL_MAP: Record<string, { type: EdgeType; entity0IsSource: boolean }> = {
  'member of band': { type: 'member_of', entity0IsSource: true },
  collaboration: { type: 'collaborated', entity0IsSource: true },
  'supporting musician': { type: 'supporting', entity0IsSource: true },
  'instrumental supporting musician': { type: 'supporting', entity0IsSource: true },
  'vocal supporting musician': { type: 'supporting', entity0IsSource: true },
  founder: { type: 'founded', entity0IsSource: true },
  // entity0 is the parent group, entity1 the subgroup
  subgroup: { type: 'subgroup_of', entity0IsSource: false },
};

export const mbKind = (type: string | null | undefined): ArtistKind =>
  type === 'Person' || type === 'Character' ? 'person' : 'group';

const clean = (s: string | null | undefined) => (s ? s : undefined);

export function toStub(a: MbArtistRef): ArtistStub {
  return {
    id: a.id,
    name: a.name,
    sortName: a['sort-name'],
    kind: mbKind(a.type),
    disambiguation: clean(a.disambiguation),
  };
}

export function toArtist(a: MbArtist): Artist {
  const wikidataUrl = a.relations?.find((r) => r.type === 'wikidata' && r.url)?.url?.resource;
  return {
    ...toStub(a),
    country: clean(a.country),
    begin: clean(a['life-span']?.begin),
    end: clean(a['life-span']?.end),
    wikidata: wikidataUrl?.match(/Q\d+$/)?.[0],
  };
}

/** Maps one relation to an edge, or null if it's a type we skip. */
export function relationToEdge(selfId: string, rel: MbRelation): Edge | null {
  const spec = REL_MAP[rel.type];
  if (!spec || rel['target-type'] !== 'artist' || !rel.artist) return null;
  const otherId = rel.artist.id;
  // With direction "forward", self is entity0; with "backward", self is entity1.
  const [entity0, entity1] = rel.direction === 'forward' ? [selfId, otherId] : [otherId, selfId];
  const [source, target] = spec.entity0IsSource ? [entity0, entity1] : [entity1, entity0];
  return {
    id: edgeId(spec.type, source, target),
    type: spec.type,
    source,
    target,
    begin: clean(rel.begin),
    end: clean(rel.end),
    attributes: rel.attributes?.length ? [...rel.attributes] : undefined,
  };
}

/** Someone who left and rejoined has several relations; fold them into one edge. */
export function mergeEdge(a: Edge, b: Edge): Edge {
  const attrs = [...new Set([...(a.attributes ?? []), ...(b.attributes ?? [])])];
  const minDate = (x?: string, y?: string) => (!x ? y : !y ? x : x < y ? x : y);
  // A missing end means "still active", which beats any end date.
  const maxEnd = !a.end || !b.end ? undefined : a.end > b.end ? a.end : b.end;
  return { ...a, begin: minDate(a.begin, b.begin), end: maxEnd, attributes: attrs.length ? attrs : undefined };
}

/** Studio albums only: primary type Album, no secondary types (Live, Compilation…). */
export function isStudioAlbum(rg: MbReleaseGroup): boolean {
  return rg['primary-type'] === 'Album' && (rg['secondary-types']?.length ?? 0) === 0;
}

export function buildSuggestions(
  mbArtist: MbArtist,
  releaseGroups: MbReleaseGroup[],
  graph: GraphData,
): SuggestResponse {
  const focus = toArtist(mbArtist);
  const accepted = new Set(graph.edges.map((e) => e.id));
  const rejected = new Set(graph.rejected);
  const hidden = { accepted: 0, rejected: 0 };

  const isHidden = (id: string) => {
    if (accepted.has(id)) return hidden.accepted++, true;
    if (rejected.has(id)) return hidden.rejected++, true;
    return false;
  };

  const byId = new Map<string, { edge: Edge; other: ArtistStub }>();
  for (const rel of mbArtist.relations ?? []) {
    const edge = relationToEdge(focus.id, rel);
    if (!edge || !rel.artist || edge.source === edge.target) continue;
    const prev = byId.get(edge.id);
    byId.set(edge.id, { edge: prev ? mergeEdge(prev.edge, edge) : edge, other: toStub(rel.artist) });
  }

  const suggestions: Suggestion[] = [];
  for (const { edge, other } of byId.values()) {
    if (isHidden(edge.id)) continue;
    suggestions.push({ kind: 'edge', edge, other, otherInGraph: !!graph.artists[other.id] });
  }

  const albums = releaseGroups
    .filter(isStudioAlbum)
    .sort((a, b) => (a['first-release-date'] ?? '9999').localeCompare(b['first-release-date'] ?? '9999'));
  for (const rg of albums) {
    const edge: Edge = { id: edgeId('released', focus.id, rg.id), type: 'released', source: focus.id, target: rg.id };
    if (isHidden(edge.id)) continue;
    const album: Album = {
      id: rg.id,
      title: rg.title,
      year: rg['first-release-date']?.slice(0, 4) || undefined,
      artistIds: [focus.id],
    };
    suggestions.push({ kind: 'album', album, edge });
  }

  // Stable order: by edge type, then by the other artist's start date.
  suggestions.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'edge' ? -1 : 1;
    if (a.kind === 'edge' && b.kind === 'edge') {
      return a.edge.type.localeCompare(b.edge.type) || (a.edge.begin ?? '').localeCompare(b.edge.begin ?? '');
    }
    return 0;
  });

  return { focus, inGraph: !!graph.artists[focus.id], suggestions, hidden };
}
