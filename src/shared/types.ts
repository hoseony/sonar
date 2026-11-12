// Data model shared by the importer, the review page and the public explorer.

export type ArtistKind = 'person' | 'group';

export interface Artist {
  /** MusicBrainz artist ID */
  id: string;
  name: string;
  sortName: string;
  kind: ArtistKind;
  country?: string;
  begin?: string;
  end?: string;
  disambiguation?: string;
  /** Wikidata Q-id, e.g. "Q213917" */
  wikidata?: string;
  /** Set once you've reviewed this artist's suggestions */
  expandedAt?: string;
}

export interface Album {
  /** MusicBrainz release-group ID */
  id: string;
  title: string;
  year?: string;
  artistIds: string[];
}

export type EdgeType =
  | 'member_of' // person → group
  | 'collaborated' // person/group → collaboration project
  | 'supporting' // supporting musician → artist
  | 'subgroup_of' // smaller group → parent group
  | 'founded' // founder → group
  | 'worked_with' // credited together on a release (Discogs: featuring, playing, producing, writing…)
  | 'released'; // artist → album

export interface Edge {
  /** `${type}:${source}:${target}` */
  id: string;
  type: EdgeType;
  source: string;
  target: string;
  begin?: string;
  end?: string;
  /** e.g. instruments for supporting musicians, "original" for members */
  attributes?: string[];
}

export interface GraphData {
  artists: Record<string, Artist>;
  albums: Record<string, Album>;
  edges: Edge[];
  /** Edge ids you rejected; never suggested again */
  rejected: string[];
}

export const edgeId = (type: EdgeType, source: string, target: string) =>
  `${type}:${source}:${target}`;

/** Short human phrase for an edge, read as "source <phrase> target". */
export const EDGE_PHRASE: Record<EdgeType, string> = {
  member_of: 'member of',
  collaborated: 'collaborated on',
  supporting: 'supporting musician for',
  subgroup_of: 'subgroup of',
  founded: 'founded',
  worked_with: 'worked with',
  released: 'released',
};

export const EDGE_LABEL: Record<EdgeType, string> = {
  member_of: 'Band members',
  collaborated: 'Collaborations',
  supporting: 'Supporting musicians',
  subgroup_of: 'Subgroups',
  founded: 'Founders',
  worked_with: 'Worked together',
  released: 'Albums',
};

// ---- Review flow ----

export interface ArtistStub {
  id: string;
  name: string;
  sortName: string;
  kind: ArtistKind;
  disambiguation?: string;
}

export type Suggestion =
  | {
      kind: 'edge';
      edge: Edge;
      /** The artist on the other end of the edge */
      other: ArtistStub;
      otherInGraph: boolean;
    }
  | { kind: 'album'; album: Album; edge: Edge };

export interface SuggestResponse {
  focus: Artist;
  inGraph: boolean;
  suggestions: Suggestion[];
  /** Counts of things hidden because they're already accepted or rejected */
  hidden: { accepted: number; rejected: number };
}

export interface SaveRequest {
  focus: Artist;
  accept: Suggestion[];
  /** Edge ids to never suggest again */
  reject: string[];
}

export interface SearchHit extends ArtistStub {
  country?: string;
  begin?: string;
  end?: string;
  score: number;
  inGraph: boolean;
}

// ---- Public export ----

export type NodeKind = ArtistKind | 'album';

export interface ExportNode {
  id: string;
  label: string;
  kind: NodeKind;
  x: number;
  y: number;
  size: number;
  country?: string;
  begin?: string;
  end?: string;
  year?: string;
  disambiguation?: string;
  wikidata?: string;
}

export interface ExportData {
  generatedAt: string;
  nodes: ExportNode[];
  edges: Edge[];
}
