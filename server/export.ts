// Builds the public graph file: nodes with precomputed ForceAtlas2 positions.
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { ExportData, ExportNode, GraphData } from '../src/shared/types.ts';

/** Deterministic pseudo-random start position from a node id, so layouts are stable. */
function seededPoint(id: string): [number, number] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  return [rand() * 100 - 50, rand() * 100 - 50];
}

export function buildExport(data: GraphData, now = new Date()): ExportData {
  const g = new Graph({ type: 'undirected', multi: true });

  for (const a of Object.values(data.artists)) {
    const [x, y] = seededPoint(a.id);
    g.addNode(a.id, { x, y });
  }
  for (const al of Object.values(data.albums)) {
    const [x, y] = seededPoint(al.id);
    g.addNode(al.id, { x, y });
  }
  const edges = data.edges.filter((e) => g.hasNode(e.source) && g.hasNode(e.target));
  for (const e of edges) g.addEdgeWithKey(e.id, e.source, e.target, { weight: e.type === 'released' ? 0.5 : 1 });

  if (g.order > 1) {
    const settings = forceAtlas2.inferSettings(g);
    forceAtlas2.assign(g, {
      iterations: g.order > 2000 ? 300 : 600,
      getEdgeWeight: 'weight',
      settings: { ...settings, barnesHutOptimize: g.order > 500, adjustSizes: false },
    });
  }

  const nodes: ExportNode[] = [];
  const pos = (id: string) => g.getNodeAttributes(id) as { x: number; y: number };
  const round = (n: number) => Math.round(n * 100) / 100;

  for (const a of Object.values(data.artists)) {
    const { x, y } = pos(a.id);
    const deg = g.degree(a.id);
    nodes.push({
      id: a.id,
      label: a.name,
      kind: a.kind,
      x: round(x),
      y: round(y),
      size: round(4 + Math.sqrt(deg) * 2.2),
      country: a.country,
      begin: a.begin,
      end: a.end,
      disambiguation: a.disambiguation,
      wikidata: a.wikidata,
    });
  }
  for (const al of Object.values(data.albums)) {
    const { x, y } = pos(al.id);
    nodes.push({
      id: al.id,
      label: al.year ? `${al.title} (${al.year})` : al.title,
      kind: 'album',
      x: round(x),
      y: round(y),
      size: 3,
      year: al.year,
    });
  }

  return { generatedAt: now.toISOString(), nodes, edges };
}
