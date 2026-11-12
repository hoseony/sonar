import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Artist, GraphData, SaveRequest } from '../src/shared/types.ts';

// GRAPH_PATH env var lets you point the tools at a scratch copy (handy for experiments).
export const GRAPH_PATH = process.env.GRAPH_PATH
  ? resolve(process.env.GRAPH_PATH)
  : resolve(import.meta.dirname, '../data/graph.json');

export async function loadGraph(path = GRAPH_PATH): Promise<GraphData> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<GraphData>;
  return {
    artists: raw.artists ?? {},
    albums: raw.albums ?? {},
    edges: raw.edges ?? [],
    rejected: raw.rejected ?? [],
  };
}

/** Writes with sorted keys so git diffs stay small and readable. */
export async function saveGraph(graph: GraphData, path = GRAPH_PATH): Promise<void> {
  const sorted: GraphData = {
    artists: sortRecord(graph.artists),
    albums: sortRecord(graph.albums),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
    rejected: [...new Set(graph.rejected)].sort(),
  };
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(sorted, null, 2) + '\n');
  await rename(tmp, path);
}

function sortRecord<T>(rec: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));
}

/** Adds or refreshes an artist. Full data (from a lookup) overwrites stub fields. */
function upsertArtist(graph: GraphData, artist: Artist) {
  const prev = graph.artists[artist.id];
  graph.artists[artist.id] = prev ? { ...prev, ...dropUndefined(artist) } : artist;
}

function dropUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Pure: applies a review save to the graph (mutates and returns it). */
export function applySave(graph: GraphData, req: SaveRequest, now = new Date()): GraphData {
  upsertArtist(graph, { ...req.focus, expandedAt: now.toISOString() });

  const edgeIds = new Set(graph.edges.map((e) => e.id));
  const rejected = new Set(graph.rejected);

  for (const s of req.accept) {
    if (s.kind === 'edge') {
      if (!graph.artists[s.other.id]) upsertArtist(graph, { ...s.other });
    } else {
      const prev = graph.albums[s.album.id];
      const artistIds = [...new Set([...(prev?.artistIds ?? []), ...s.album.artistIds])];
      graph.albums[s.album.id] = { ...prev, ...s.album, artistIds };
    }
    if (!edgeIds.has(s.edge.id)) {
      graph.edges.push(s.edge);
      edgeIds.add(s.edge.id);
    }
    rejected.delete(s.edge.id);
  }

  for (const id of req.reject) if (!edgeIds.has(id)) rejected.add(id);
  graph.rejected = [...rejected];
  return graph;
}

/** Artists already in the graph but not yet reviewed, most-connected first. */
export function frontier(graph: GraphData) {
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return Object.values(graph.artists)
    .filter((a) => !a.expandedAt)
    .map((a) => ({ ...a, degree: degree.get(a.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || a.sortName.localeCompare(b.sortName));
}
