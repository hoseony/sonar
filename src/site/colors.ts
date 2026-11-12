// Scene colors: the map is split into communities (Louvain), and each community gets its own
// hue, so e.g. the Chicago post-rock circle and the Canterbury scene read as different colors.
// Colors stay put as the map grows: a recomputed community keeps the color most of its members
// already had, so nothing reshuffles while you look.
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

// Vivid on dark backgrounds…
const DARK = [
  '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7',
  '#9775fa', '#f783ac', '#e599f7', '#74c0fc', '#a9e34b', '#ff8787',
];
// …and deep enough to read on light ones.
const LIGHT = [
  '#e03131', '#e8590c', '#e67700', '#2f9e44', '#0c8599', '#1971c2',
  '#6741d9', '#c2255c', '#9c36b5', '#1c7ed6', '#5c940d', '#c92a2a',
];

export function palette(): string[] {
  return matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT;
}

/**
 * The same hue, darker: people use this so they read as part of their scene but distinct from
 * bands, which keep the bright color. `amount` 0–1 mixes toward black.
 */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c * (1 - amount));
  const out = (f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255);
  return `#${out.toString(16).padStart(6, '0')}`;
}

/** "#rrggbb" + alpha (0–1) → "rgba(…)" */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export class SceneColors {
  /** node → palette index */
  private colorOf = new Map<string, number>();
  /** node → scene (community) id; ids are stable-ish labels, not colors (colors repeat). */
  private sceneOf = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastRun = 0;

  constructor(
    private graph: Graph,
    private onChange: () => void,
  ) {}

  index(node: string): number | undefined {
    return this.colorOf.get(node);
  }

  /** The scene (community) a node belongs to, for layout. */
  scene(node: string): number | undefined {
    return this.sceneOf.get(node);
  }

  /** Recompute soon (debounced; at most every ~0.7 s while the map is growing). */
  schedule() {
    clearTimeout(this.timer);
    const wait = Math.max(250, 700 - (performance.now() - this.lastRun));
    this.timer = setTimeout(() => this.recompute(), wait);
  }

  clear() {
    clearTimeout(this.timer);
    this.colorOf.clear();
    this.sceneOf.clear();
  }

  recompute() {
    this.lastRun = performance.now();
    const g = this.graph;
    if (g.order < 2) {
      g.forEachNode((n) => this.colorOf.set(n, this.colorOf.get(n) ?? 0));
      this.onChange();
      return;
    }
    // Louvain wants a simple graph: collapse parallel edges.
    const simple = new Graph({ type: 'undirected' });
    g.forEachNode((n) => simple.addNode(n));
    g.forEachEdge((_e, _a, s, t) => {
      if (s !== t && !simple.hasEdge(s, t)) simple.addEdge(s, t);
    });
    const community = louvain(simple, { resolution: 1, rng: seeded(7) }) as Record<string, number>;

    // Group nodes by community, biggest first: big scenes claim their colors first.
    const groups = new Map<number, string[]>();
    for (const [node, c] of Object.entries(community)) {
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c)!.push(node);
    }
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
    this.sceneOf = new Map();
    ordered.forEach((members, i) => {
      for (const m of members) this.sceneOf.set(m, i);
    });

    const size = DARK.length;
    const used = new Array<number>(size).fill(0);
    const next = new Map<string, number>();
    for (const members of ordered) {
      // The color most of these nodes already had, if it isn't taken by a bigger scene yet.
      const votes = new Array<number>(size).fill(0);
      for (const m of members) {
        const prev = this.colorOf.get(m);
        if (prev !== undefined) votes[prev]++;
      }
      let pick = -1;
      let best = 0;
      for (let i = 0; i < size; i++) {
        if (votes[i] > best && used[i] === 0) {
          best = votes[i];
          pick = i;
        }
      }
      // Otherwise the least-used color (palettes repeat once there are more scenes than colors).
      if (pick < 0) pick = used.indexOf(Math.min(...used));
      used[pick] += members.length;
      for (const m of members) next.set(m, pick);
    }
    this.colorOf = next;
    this.onChange();
  }
}

/** Small deterministic RNG so communities (and their colors) don't flicker between runs. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
