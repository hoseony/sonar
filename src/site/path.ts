// "How are X and Y connected?": shortest path over the currently visible graph.
import type Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted';

export interface PathResult {
  nodes: string[];
  edges: string[];
}

export function findPath(
  graph: Graph,
  from: string,
  to: string,
  isEdgeVisible: (edge: string) => boolean,
): PathResult | null {
  // Copy only visible edges so filters (e.g. "hide albums") also shape the path.
  const sub = graph.emptyCopy();
  graph.forEachEdge((edge, attrs, s, t) => {
    if (isEdgeVisible(edge)) sub.addEdgeWithKey(edge, s, t, attrs);
  });
  const nodes = bidirectional(sub, from, to);
  if (!nodes) return null;
  const edges: string[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push(sub.edges(nodes[i], nodes[i + 1])[0]);
  }
  return { nodes, edges };
}
