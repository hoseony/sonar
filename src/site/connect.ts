// "How are these two artists connected?" for ANY two artists, not just ones already on the map.
// Searches outward from both ends at once over the static index until the two searches meet.
import { h } from '../shared/dom.ts';
import type { Edge, NodeKind } from '../shared/types.ts';
import { fetchConnections, type Connections } from './live.ts';
import { attachSearch, type SearchIndex, type SearchItem } from './search.ts';

/** Longest chain the search looks for. */
export const MAX_STEPS = 20;
/** Chains longer than this are labeled as distant connections. */
export const DISTANT_STEPS = 12;

/** Groups this big (e.g. "1,000 UK Artists") aren't used as stepping stones: they'd connect anyone. */
const HUGE_GROUP = 150;

export interface ConnectionFound {
  /** Artist ids from start to end */
  nodes: string[];
  /** The edge between each consecutive pair */
  edges: Edge[];
  /** Name/kind for every artist on the path (for adding them to the map) */
  info: Map<string, { name: string; kind: Exclude<NodeKind, 'album'> }>;
}

export interface SearchProgress {
  checked: number;
  depth: number;
}

/**
 * Bidirectional breadth-first search. Each round expands whichever side has the smaller frontier,
 * one whole level at a time, so the first meeting point gives a shortest chain.
 * Returns null if there's no connection within the limits.
 */
export async function findConnection(
  from: string,
  to: string,
  opts: { maxSteps?: number; maxLookups?: number; signal?: { cancelled: boolean }; onProgress?: (p: SearchProgress) => void } = {},
): Promise<ConnectionFound | null | 'cancelled'> {
  // Measured on the real index: between well-connected artists (10+ connections) the median chain
  // is ~11 steps; ≤12 finds ~62% of existing connections, ≤20 finds ~97%. Typical searches need a few
  // hundred lookups, the longest ~12,000.
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const maxLookups = opts.maxLookups ?? 15000;
  if (from === to) return { nodes: [from], edges: [], info: new Map() };

  // For each side: artist → [previous artist on the way back to that side's start, edge used]
  const side = [new Map<string, [string, Edge] | null>([[from, null]]), new Map<string, [string, Edge] | null>([[to, null]])];
  let frontier: [string[], string[]] = [[from], [to]];
  const info = new Map<string, { name: string; kind: Exclude<NodeKind, 'album'> }>();
  let checked = 0;

  const lookup = async (id: string): Promise<Connections | null> => {
    try {
      return await fetchConnections(id, { indexOnly: true });
    } catch {
      return null;
    }
  };

  for (let steps = 0; steps < maxSteps; steps++) {
    const s = frontier[0].length <= frontier[1].length ? 0 : 1;
    const mine = side[s];
    const other = side[1 - s];
    if (!frontier[s].length) return null;
    const next: string[] = [];

    // Look up this level in parallel batches (the index downloader caps concurrency).
    for (let i = 0; i < frontier[s].length; i += 48) {
      if (opts.signal?.cancelled) return 'cancelled';
      const batch = frontier[s].slice(i, i + 48);
      const results = await Promise.all(batch.map(lookup));
      for (let j = 0; j < batch.length; j++) {
        const id = batch[j];
        const res = results[j];
        checked++;
        if (!res) continue;
        info.set(id, { name: res.artist.name, kind: res.artist.kind });
        const isEndpoint = id === from || id === to;
        if (!isEndpoint && res.neighbors.length >= HUGE_GROUP) continue; // don't route through collectives
        for (const nb of res.neighbors) {
          if (mine.has(nb.id)) continue;
          const edge = res.edges.find((e) => e.source === nb.id || e.target === nb.id)!;
          mine.set(nb.id, [id, edge]);
          if (!info.has(nb.id)) info.set(nb.id, { name: nb.name, kind: nb.kind });
          if (other.has(nb.id)) return build(nb.id, side[0], side[1], info);
          next.push(nb.id);
        }
      }
      opts.onProgress?.({ checked, depth: steps + 1 });
      if (checked >= maxLookups) return null;
    }
    frontier[s] = next;
  }
  return null;
}

function build(
  meet: string,
  fromSide: Map<string, [string, Edge] | null>,
  toSide: Map<string, [string, Edge] | null>,
  info: ConnectionFound['info'],
): ConnectionFound {
  const left: string[] = [];
  const leftEdges: Edge[] = [];
  for (let cur: string | undefined = meet; cur !== undefined; ) {
    left.unshift(cur);
    const p = fromSide.get(cur);
    if (!p) break;
    leftEdges.unshift(p[1]);
    cur = p[0];
  }
  const right: string[] = [];
  const rightEdges: Edge[] = [];
  for (let cur = toSide.get(meet); cur; cur = toSide.get(cur[0])) {
    right.push(cur[0]);
    rightEdges.push(cur[1]);
  }
  return { nodes: [...left, ...right], edges: [...leftEdges, ...rightEdges], info };
}

// ---------- The "Connect" menu ----------

export interface ConnectUI {
  /** Pre-fill "From" (e.g. with the artist you're looking at) */
  setFrom: (item: SearchItem | null) => void;
}

/**
 * Two artist pickers ("From" / "To", searching the map and MusicBrainz) and a Find button.
 */
export function mountConnect(
  root: HTMLElement,
  opts: {
    index: SearchIndex;
    remote: (q: string) => Promise<SearchItem[]>;
    onFind: (from: SearchItem, to: SearchItem) => void;
  },
): ConnectUI {
  let from: SearchItem | null = null;
  let to: SearchItem | null = null;
  const findBtn = h('button', { type: 'button', class: 'primary', disabled: true }, 'Find connection');

  const picker = (label: string, set: (v: SearchItem | null) => void) => {
    const chosen = h('div', { class: 'chosen', hidden: true });
    const input = h('input', { type: 'search', placeholder: `${label}: search an artist…`, autocomplete: 'off' });
    const list = h('ul', { class: 'dropdown', role: 'listbox', hidden: true });
    const show = (v: SearchItem | null) => {
      set(v);
      findBtn.disabled = !(from && to);
      chosen.hidden = !v;
      input.hidden = !!v;
      chosen.replaceChildren(
        ...(v
          ? [
              h('span', { class: 'role' }, label),
              h('span', { class: `dot ${v.kind}` }),
              h('span', { class: 'name' }, v.label),
              h('button', { type: 'button', class: 'linklike', onclick: () => (show(null), input.focus()) }, 'change'),
            ]
          : []),
      );
    };
    attachSearch(input, list, opts.index, (item) => show(item), { remote: opts.remote });
    return { el: h('div', { class: 'picker' }, chosen, input, list), show };
  };

  const fromPicker = picker('From', (v) => (from = v));
  const toPicker = picker('To', (v) => (to = v));
  findBtn.addEventListener('click', () => from && to && opts.onFind(from, to));

  root.replaceChildren(
    h('p', { class: 'muted hint' }, 'Find the shortest chain of bands and bandmates between any two artists.'),
    fromPicker.el,
    toPicker.el,
    h('div', { class: 'layout-buttons' }, findBtn),
  );
  return { setFrom: (item) => fromPicker.show(item) };
}
