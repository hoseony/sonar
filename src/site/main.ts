import '../shared/base.css';
import './site.css';
import Graph from 'graphology';
import Sigma from 'sigma';
import { sdfCircle } from 'sigma/rendering';
import { layerBorder } from '@sigma/node-border';
import { h, years } from '../shared/dom.ts';
import { EDGE_LABEL, type ArtistStub, type Edge, type EdgeType, type ExportData, type ExportNode } from '../shared/types.ts';
import { activity } from './activity.ts';
import { findConnection, MAX_STEPS, mountConnect } from './connect.ts';
import { palette, SceneColors, shade, withAlpha } from './colors.ts';
import { loadPrefs, mountLayoutControls } from './layout-controls.ts';
import { connectionCount, fetchAlbums, fetchConnections, indexStats, prefetch, searchArtists } from './live.ts';
import { renderPanel, type PanelContext } from './panel.ts';
import { findPath, type PathResult } from './path.ts';
import { Physics } from './physics.ts';
import { attachSearch, type SearchIndex, type SearchItem } from './search.ts';
import { track } from './stats.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const container = $<HTMLDivElement>('graph');
const panel = $<HTMLElement>('panel');
const status = $<HTMLDivElement>('status');
const searchInput = $<HTMLInputElement>('search');

/** Starting points on the welcome screen (from the original hand-made vault). */
const SUGGESTIONS: { id: string; label: string; kind: 'group' | 'person' }[] = [
  { id: 'e0953daa-860f-4dc8-9f1a-b12587cdaf17', label: 'Tortoise', kind: 'group' },
  { id: '5193ce6b-a315-4c50-ae49-54e69ffbc988', label: 'Soft Machine', kind: 'group' },
  { id: 'd0f25f16-7782-42e8-8047-c16a1cb2b450', label: 'Fishmans', kind: 'group' },
  { id: '4dfadf48-e15b-4fc2-a800-2b68702a72d5', label: 'Penguin Cafe Orchestra', kind: 'group' },
  { id: '13501c7d-d181-45ba-af52-5f101d8516a0', label: 'Can', kind: 'group' },
  { id: '2869c510-2679-4a3f-bf15-e5e8b49f2f28', label: 'Slint', kind: 'group' },
  { id: 'f1df0431-9250-4ec8-95d8-f19ce7cf7fb6', label: 'Stereolab', kind: 'group' },
  { id: '5a54b72e-bfb3-4ca6-944a-e17261399965', label: 'Pere Ubu', kind: 'group' },
  { id: 'd5da1841-9bc8-4813-9f89-11098090148e', label: 'The Fall', kind: 'group' },
];

// ---------- Theme ----------

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let theme = readTheme();
function readTheme() {
  return {
    person: css('--person'),
    group: css('--group'),
    album: css('--album'),
    edge: css('--edge'),
    faded: css('--faded'),
    text: css('--text'),
    muted: css('--muted'),
    accent: css('--accent'),
    surface: css('--surface'),
    bg: css('--bg'),
    labelBg: withAlpha(css('--bg'), 0.8),
    pal: palette(),
  };
}

// ---------- State ----------

const state = {
  selected: null as string | null,
  hovered: null as string | null,
  /** A name hovered in the side panel: highlighted on the map */
  peek: null as string | null,
  path: null as PathResult | null,
  edgeTypes: new Set<EdgeType>(['member_of', 'founded', 'subgroup_of', 'collaborated', 'supporting', 'worked_with', 'released']),
  /** Recently visited artists, oldest first (the trail at the top of the panel) */
  trail: [] as string[],
  /** The artist you searched for (or opened from a link): stays highlighted as your starting point */
  origin: null as string | null,
  /**
   * Showing a found connection: only the chain is on the map, nothing grows on its own and scenes
   * aren't pulled into islands (that would tear the chain apart). Clicking a step leaves this mode.
   */
  connectView: false,
  /** The chain shown in the connection view (stays highlighted while you click around it) */
  chain: null as PathResult | null,
};

const graph = new Graph({ type: 'undirected', multi: true });
const nodeById = new Map<string, ExportNode>();
const edgeById = new Map<string, Edge>();
/** Artists whose connections have been fetched */
const expanded = new Set<string>();
const loading = new Set<string>();
const failed = new Set<string>();
/**
 * Huge collectives (e.g. "1,000 UK Artists", a 2024 protest album credited to 1,000+ musicians)
 * would link hundreds of unrelated artists. Automatic growth leaves them closed; click to open.
 */
const HUGE_GROUP = 150;
const collectives = new Set<string>();

const prefs = loadPrefs();
const physics = new Physics(graph, prefs);

/** Grows with connections, but slowly past 100: hubs (B.B. King has ~1,000) mustn't cover the map. */
const degreeSize = (d: number) => 4 + Math.sqrt(Math.min(d, 100)) * 2.2 + (d > 100 ? 4 * Math.log2(d / 100) : 0);
const nodeSize = (id: string) => (nodeById.get(id)?.kind === 'album' ? 3 : degreeSize(graph.degree(id)));

function upsertNode(n: Omit<ExportNode, 'x' | 'y' | 'size'>, near?: { x: number; y: number }, i = 0, total = 1) {
  const prev = nodeById.get(n.id);
  if (prev) {
    // Keep the position; fill in details we didn't have (a stub becomes a full artist).
    for (const [k, v] of Object.entries(n)) if (v !== undefined) (prev as unknown as Record<string, unknown>)[k] = v;
    graph.mergeNodeAttributes(n.id, { label: prev.label, kind: prev.kind });
    return;
  }
  // New nodes start around the node they came from at about one link-length away (close to where
  // the forces want them), so there's little to push apart and nothing shoots off.
  const angle = (2 * Math.PI * i) / Math.max(total, 1) + Math.random() * 0.3;
  const r = near ? prefs.linkDistance * (0.8 + Math.random() * 0.4) : 0;
  const x = (near?.x ?? 0) + Math.cos(angle) * r;
  const y = (near?.y ?? 0) + Math.sin(angle) * r;
  nodeById.set(n.id, { ...n, x, y, size: 0 });
  graph.addNode(n.id, { x, y, size: 0, label: n.label, kind: n.kind });
  sizeTargets.set(n.id, 4);
}

// ---------- Size animation ----------

/** Nodes ease toward these sizes each frame (new nodes grow in; hubs swell as they gain links). */
const sizeTargets = new Map<string, number>();
let sizeFrame = 0;

function resizeNodes(ids: Iterable<string>) {
  for (const id of ids) if (graph.hasNode(id)) sizeTargets.set(id, nodeSize(id));
  if (!sizeFrame) sizeFrame = requestAnimationFrame(stepSizes);
}

function stepSizes() {
  sizeFrame = 0;
  for (const [id, target] of sizeTargets) {
    if (!graph.hasNode(id)) {
      sizeTargets.delete(id);
      continue;
    }
    const cur = graph.getNodeAttribute(id, 'size') as number;
    const next = cur + (target - cur) * 0.2;
    if (Math.abs(target - next) < 0.05) {
      graph.setNodeAttribute(id, 'size', target);
      sizeTargets.delete(id);
    } else {
      graph.setNodeAttribute(id, 'size', next);
    }
  }
  if (sizeTargets.size) sizeFrame = requestAnimationFrame(stepSizes);
}

function addEdge(e: Edge) {
  if (edgeById.has(e.id) || !graph.hasNode(e.source) || !graph.hasNode(e.target)) return;
  edgeById.set(e.id, e);
  graph.addEdgeWithKey(e.id, e.source, e.target, { type: e.type, size: e.type === 'released' ? 0.5 : 1 });
}

const stubNode = (a: ArtistStub) => ({ id: a.id, label: a.name, kind: a.kind, disambiguation: a.disambiguation });

// ---------- Boot ----------

async function loadSeed(): Promise<ExportData | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}graph.export.json`, { cache: 'no-cache' });
    return res.ok ? ((await res.json()) as ExportData) : null;
  } catch {
    return null;
  }
}

async function boot() {
  // A hand-picked graph (if any) is the starting view; search grows it live.
  const seed = await loadSeed();
  const SEED_SCALE = 12; // export positions are in small units; the view uses pixels
  for (const n of seed?.nodes ?? []) {
    nodeById.set(n.id, { ...n });
    graph.addNode(n.id, { x: n.x * SEED_SCALE, y: n.y * SEED_SCALE, size: n.size, label: n.label, kind: n.kind });
  }
  for (const e of seed?.edges ?? []) addEdge(e);
  physics.sync();

  // ---------- Welcome screen ----------

  status.replaceChildren(
    h('h1', null, 'Who played with whom?'),
    h('p', { class: 'muted' }, 'Search any artist to map their bands, members and collaborators, and keep exploring outward.'),
    h(
      'div',
      { class: 'chips' },
      SUGGESTIONS.map((s) =>
        h('button', { type: 'button', class: 'chip', onclick: () => void openArtist(s) }, h('span', { class: `dot ${s.kind}` }), s.label),
      ),
    ),
    h(
      'p',
      { class: 'muted keys' },
      h('kbd', null, '/'),
      ' search · drag or swipe to move · pinch to zoom · ',
      h('kbd', null, 'H'),
      ' back to start · ',
      h('kbd', null, 'Esc'),
      ' overview',
    ),
  );
  const showEmpty = () => {
    status.hidden = graph.order > 0;
  };
  showEmpty();

  // ---------- Batched UI updates ----------
  // A level can mean thousands of lookups. Each one only marks what changed; the derived work
  // (physics catching up, focus sets, repaint, panel) runs at most once per frame in flushNow().

  /** Nodes or edges were added: physics, scene colors and the welcome screen need to catch up. */
  let graphDirty = false;
  /** Focus sets and the map need recomputing / repainting. */
  let focusDirty = false;
  /** 'force': re-render the panel. 'progress': re-render unless you're typing in it (then just the progress line). */
  let panelDirty: false | 'progress' | 'force' = false;
  let flushFrame = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const isNodeVisible = (id: string) => nodeById.get(id)?.kind !== 'album' || state.edgeTypes.has('released');
  const isEdgeVisible = (id: string) => {
    const e = edgeById.get(id);
    return !!e && state.edgeTypes.has(e.type) && isNodeVisible(e.source) && isNodeVisible(e.target);
  };

  // ---------- Highlighting ----------

  /** Nodes to emphasize: the path, else the selection's neighborhood, else the hovered node's. */
  let focusNodes: Set<string> | null = null;
  let focusEdges: Set<string> | null = null;
  let secondNodes = new Set<string>();
  let secondEdges = new Set<string>();
  let sharedNodes = new Set<string>();

  function computeFocus() {
    secondNodes = new Set();
    secondEdges = new Set();
    sharedNodes = new Set();
    if (state.path) {
      focusNodes = new Set(state.path.nodes);
      focusEdges = new Set(state.path.edges);
      // Context around a chain: everything directly connected to a step shows as the second level.
      for (const n of state.path.nodes) {
        if (!graph.hasNode(n)) continue;
        graph.forEachEdge(n, (edge, _a, s, t) => {
          if (!isEdgeVisible(edge) || focusEdges!.has(edge)) return;
          secondEdges.add(edge);
          const m = s === n ? t : s;
          if (!focusNodes!.has(m)) secondNodes.add(m);
        });
      }
      return;
    }
    const center = state.selected ?? state.hovered;
    if (!center || !graph.hasNode(center)) {
      focusNodes = focusEdges = null;
      return;
    }
    focusNodes = new Set([center]);
    focusEdges = new Set();
    graph.forEachEdge(center, (edge, _a, s, t) => {
      if (!isEdgeVisible(edge)) return;
      focusEdges!.add(edge);
      focusNodes!.add(s === center ? t : s);
    });
    // A selected artist also shows the second level (members' other bands, bandmates' other members).
    if (!state.selected) return;
    const hits = new Map<string, Set<string>>();
    for (const n of focusNodes) {
      if (n === center) continue;
      graph.forEachEdge(n, (edge, _a, s, t) => {
        if (!isEdgeVisible(edge) || focusEdges!.has(edge)) return;
        secondEdges.add(edge);
        const m = s === n ? t : s;
        if (focusNodes!.has(m)) return;
        secondNodes.add(m);
        if (!hits.has(m)) hits.set(m, new Set());
        hits.get(m)!.add(n);
      });
    }
    // Bands shared by two or more members (or people in two or more of the bands) always get a label.
    for (const [m, via] of hits) if (via.size >= 2) sharedNodes.add(m);
  }

  // Scene colors: recomputed (debounced) as the map grows; colors stay stable between runs.
  /** The most connected artist of each scene: always labeled, so every island has a name. */
  let sceneNames = new Set<string>();
  const scenes = new SceneColors(graph, () => {
    // Scenes changed: lay them out as separate islands, and repaint colors.
    // Physics must know every node first, or newcomers would miss their island.
    if (graphDirty) flushNow();
    physics.setScenes(state.connectView ? () => undefined : (id) => scenes.scene(id));
    const best = new Map<number, [string, number]>();
    const size = new Map<number, number>();
    graph.forEachNode((n) => {
      const sc = scenes.scene(n);
      if (sc === undefined || nodeById.get(n)?.kind === 'album') return;
      size.set(sc, (size.get(sc) ?? 0) + 1);
      const d = graph.degree(n);
      if (!best.has(sc) || d > best.get(sc)![1]) best.set(sc, [n, d]);
    });
    sceneNames = new Set([...best].filter(([sc]) => (size.get(sc) ?? 0) >= 6).map(([, [n]]) => n));
    renderer?.refresh({ skipIndexation: true });
  });

  /** A node's scene color (albums stay neutral). Bands get the bright color, people a darker shade. */
  const hueOf = (key: string, kind: ExportNode['kind']) => {
    if (kind === 'album') return theme.album;
    const ci = scenes.index(key);
    const hue = ci === undefined ? theme.group : theme.pal[ci % theme.pal.length];
    return kind === 'person' ? shade(hue, PERSON_SHADE) : hue;
  };

  /** How much darker people are than bands of the same scene. */
  const PERSON_SHADE = 0.38;

  // Plain objects in, sigma display data out (custom variables like innerColor aren't in its types).
  /** The node being styled right now (see the node reducer). */
  let styling: string | null = null;
  // Every node style goes through here. The hovered node keeps its look (selected, start, …) but
  // its map label steps aside: the hover chip takes its place, so there's only ever one label.
  const look = (o: Record<string, unknown>) =>
    (styling !== null && styling === state.hovered
      ? { ...o, labelVisibility: 'hidden', backdropVisibility: 'hidden', highlighted: true, zIndex: Math.max(5, (o.zIndex as number) ?? 0) }
      : o) as never;

  const renderer = new Sigma(graph, container, {
    // Nodes are circles. An artist whose connections aren't loaded yet is a hollow ring
    // ("there's more here, click me"); loaded ones are solid.
    primitives: {
      nodes: {
        // Labels: the system UI font at semi-bold (thin default sans-serif was hard to read), with
        // Japanese / Korean fallbacks for names like フィッシュマンズ.
        label: {
          font: {
            family: 'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Apple SD Gothic Neo", "Noto Sans CJK JP", sans-serif',
            weight: '600',
            size: 12,
          },
          margin: 6,
        },
        shapes: [sdfCircle()],
        variables: { innerColor: { type: 'color', default: '#000000' } },
        layers: [
          layerBorder({
            borders: [
              { size: 0.3, color: { attribute: 'color' }, mode: 'relative' },
              { size: 0, color: { attribute: 'innerColor' }, mode: 'relative', fill: true },
            ],
          }),
        ],
      },
    },
    settings: {
      itemSizesReference: 'screen', // node sizes are pixels
      // Names appear wherever there's room (sigma never lets two overlap); labels have a soft
      // background, so more of them can show without becoming noise. More appear as you zoom in.
      labelRenderedSizeThreshold: 8,
      labelDensity: 0.55,
      hideEdgesOnMove: false,
      stagePadding: 40,
      allowInvalidContainer: true, // e.g. loaded in a hidden tab; ResizeObserver below catches up
      enableNodeDrag: true,
      // Fixed mapping (1 unit = 1 px): the view never rescales itself as the graph grows.
      autoRescale: false,
      // Zooming in keeps nodes at their normal size (no ballooning); zooming out shrinks them.
      zoomToSizeRatioFunction: (r: number) => (r < 1 ? 1 : Math.sqrt(r)),
      minCameraRatio: 0.15,
      maxCameraRatio: 60,
    },
    nodeReducer: (key, _data, attrs) => {
      styling = key;
      if (!isNodeVisible(key)) return { visibility: 'hidden' };
      const kind = attrs.kind as ExportNode['kind'];
      const hue = hueOf(key, kind);
      const solid = kind === 'album' || expanded.has(key);
      const base = {
        color: hue,
        innerColor: solid ? hue : theme.bg,
        labelColor: theme.text,
        // Every label sits on a soft patch of background so it stays readable over lines and dots.
        labelBackgroundColor: theme.labelBg,
        labelBackgroundPadding: 3,
        backdropColor: theme.surface,
      };
      // A name hovered in the panel lights up on the map, whatever else is going on.
      if (key === state.peek) return look({ ...base, labelVisibility: 'visible', zIndex: 5, highlighted: true, size: (attrs.size as number) + 3 });
      // Your starting point is always findable: a bright ring (text color: white on dark, near-black
      // on light) around its scene color, bigger, always labeled.
      // Its name sits on a solid pill so it reads against anything behind it.
      if (key === state.origin) {
        return look({
          ...base,
          color: theme.text,
          innerColor: hue,
          labelVisibility: 'visible',
          labelSize: 15,
          backdropVisibility: 'visible',
          zIndex: 6,
          highlighted: true,
          size: (attrs.size as number) + 6,
        });
      }
      // Connection view: every step of the chain is always named; the far end gets a pill too.
      if (state.connectView && state.chain?.nodes.includes(key)) {
        const end = key === state.chain.nodes[state.chain.nodes.length - 1];
        return look({
          ...base,
          labelVisibility: 'visible',
          labelSize: end ? 15 : 13,
          backdropVisibility: end || key === state.selected ? 'visible' : 'hidden',
          zIndex: 5,
          highlighted: key === state.selected,
          size: (attrs.size as number) + (end ? 4 : 1),
        });
      }
      // One-band members ("leaves") carry little connection information but are most of the dots
      // on a big map, so outside the current focus they're drawn small and faint. Bridges (artists
      // in several bands) and bands keep full weight: that's where the interesting structure is.
      const leaf = kind !== 'album' && graph.degree(key) <= 1 && key !== state.selected;
      const quiet = (alpha: number) => {
        const c = withAlpha(hue, alpha);
        return { ...base, color: c, innerColor: solid ? c : theme.bg, size: (attrs.size as number) * 0.55, label: null };
      };
      if (!focusNodes) {
        if (sceneNames.has(key)) return look({ ...base, labelVisibility: 'visible', labelSize: 14, zIndex: 2 });
        // Other names at the overview: smaller and quieter than the island names.
        return look(leaf ? { ...quiet(0.5), zIndex: 0 } : { ...base, labelSize: 11, labelColor: theme.muted, zIndex: 1 });
      }
      if (focusNodes.has(key)) {
        // The selected artist always gets a name (on a pill); small neighborhoods are all named.
        // Otherwise sigma's label grid places names only where they don't overlap.
        const sel = key === state.selected;
        const forced = sel || focusNodes.size <= 12;
        return look({
          ...base,
          labelVisibility: forced ? 'visible' : 'auto',
          backdropVisibility: sel ? 'visible' : 'hidden',
          labelSize: sel ? 15 : 12,
          zIndex: sel ? 4 : 3,
          highlighted: sel,
        });
      }
      // Second level: names smaller and muted, so the selection and its direct connections lead.
      const second = { ...base, labelSize: 11, labelColor: theme.muted };
      if (sharedNodes.has(key)) return look({ ...second, labelVisibility: 'auto', zIndex: 2 });
      if (secondNodes.has(key)) return look(leaf ? { ...quiet(0.6), zIndex: 1 } : { ...second, zIndex: 2 });
      // Everything else keeps a hint of its scene color.
      if (leaf) return look({ ...quiet(0.12), zIndex: 0 });
      const dim = withAlpha(hue, 0.22);
      return look({ ...base, color: dim, innerColor: solid ? dim : theme.bg, label: null, zIndex: 0 });
    },
    edgeReducer: (key, _data, _attrs, _st, _gs, g) => {
      if (!isEdgeVisible(key)) return { visibility: 'hidden' };
      const [s, t] = g.extremities(key);
      if (state.peek && state.selected) {
        const touches = (s === state.peek && t === state.selected) || (t === state.peek && s === state.selected);
        if (touches) return { color: theme.accent, size: 2.5, zIndex: 4 };
      }
      // Links inside a scene take its color. Links between scenes are what made the map look like
      // a grey hairball, so they're barely-there by default and only show properly when they
      // touch what you're looking at.
      const sa = scenes.scene(s);
      const inScene = sa !== undefined && sa === scenes.scene(t);
      const ci = scenes.index(s);
      const hue = inScene && ci !== undefined ? theme.pal[ci % theme.pal.length] : null;
      const toLeaf = g.degree(s) <= 1 || g.degree(t) <= 1;
      if (!focusEdges) {
        if (!hue) return { color: withAlpha(theme.muted, 0.1), size: 0.5, zIndex: 0 };
        return { color: withAlpha(hue, toLeaf ? 0.2 : 0.5), size: toLeaf ? 0.6 : 1 };
      }
      if (focusEdges.has(key)) {
        if (state.path) return { color: theme.accent, size: 2.5, zIndex: 2 };
        return { color: hue ?? withAlpha(theme.text, 0.55), size: 1.4, zIndex: 2 };
      }
      if (secondEdges.has(key)) {
        if (!hue) return { color: withAlpha(theme.muted, 0.18), size: 0.6, zIndex: 1 };
        return { color: withAlpha(hue, toLeaf ? 0.18 : 0.4), size: toLeaf ? 0.6 : 1, zIndex: 1 };
      }
      // Everything unrelated to the selection: scene-internal links keep a faint tint;
      // links between scenes disappear entirely.
      if (!hue) return { visibility: 'hidden' };
      return { color: withAlpha(hue, 0.08), zIndex: 0 };
    },
  });

  new ResizeObserver(() => renderer.resize(true).refresh()).observe(container);
  scenes.recompute();

  const refresh = () => {
    focusDirty = false;
    computeFocus();
    renderer.refresh({ skipIndexation: true });
  };
  const rerenderPanel = () => {
    panelDirty = false;
    renderPanel(panel, ctx, state.selected, state.path);
  };

  /** Queues the batched updates for the next frame (or ~250 ms, if frames are throttled, e.g. a background tab). */
  function scheduleFlush() {
    if (!flushFrame) flushFrame = requestAnimationFrame(() => flushNow());
    if (flushTimer === undefined) flushTimer = setTimeout(() => flushNow(), 250);
  }

  /** Runs any pending batched updates right now (for code that needs up-to-date state). */
  function flushNow() {
    if (flushFrame) cancelAnimationFrame(flushFrame);
    clearTimeout(flushTimer);
    flushFrame = 0;
    flushTimer = undefined;
    if (graphDirty) {
      graphDirty = false;
      physics.sync();
      scenes.schedule();
      showEmpty();
    }
    if (focusDirty) refresh();
    if (panelDirty === 'force') rerenderPanel();
    else if (panelDirty === 'progress') {
      // Re-rendering would steal focus from an input you're typing in: only update the progress line.
      if (panel.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') {
        panelDirty = false;
        const el = panel.querySelector('.progress');
        if (el && progress.id) el.textContent = progressText(progress.id);
      } else rerenderPanel();
    }
  }

  /** Drops pending updates (the map is being cleared anyway). */
  function discardFlush() {
    if (flushFrame) cancelAnimationFrame(flushFrame);
    clearTimeout(flushTimer);
    flushFrame = 0;
    flushTimer = undefined;
    graphDirty = focusDirty = panelDirty = false;
  }

  // ---------- Live expansion ----------

  /** Bumped whenever a new artist is explored, which cancels the previous lookups. */
  let exploreToken = 0;
  const progress = { id: null as string | null, done: 0, total: 0 };

  if (import.meta.env.DEV) {
    Object.assign(window, {
      __mn: { graph, renderer, physics, nodeById, edgeById, expanded, loading, failed, indexStats, token: () => exploreToken },
    });
  }

  /**
   * A search: the artist, everyone connected to them (members / bands), and those people's own
   * connections. Then it stops and offers "Explore one more level" (see AUTO_GROWTH_ARTISTS).
   */
  async function explore(id: string) {
    const token = ++exploreToken;
    activity.clear('deep');
    const name = () => nodeById.get(id)?.label ?? 'artist';
    if (!expanded.has(id)) activity.set('load', `Loading ${name()}…`);
    await expand(id);
    activity.clear('load');
    if (token !== exploreToken || !expanded.has(id)) return;
    track(`open: ${name()}`);
    if (state.selected === id && !userCamera) fitNodes(oneHop(id), 700, 1.8, 1);
    // While the map grows and settles around them, keep this artist in the middle of the view.
    const growth = { done: false };
    followArtist(id, token, growth);

    // Every connected artist: bands and members (MusicBrainz) first, then people they made records with.
    const isCredit = (n: string) => graph.edges(id, n).every((e) => graph.getEdgeAttribute(e, 'type') === 'worked_with');
    const neighbours = graph.neighbors(id).filter((n) => nodeById.get(n)?.kind !== 'album' && !expanded.has(n));
    const queue = [...neighbours.filter((n) => !isCredit(n)), ...neighbours.filter(isCredit)];
    Object.assign(progress, { id, done: 0, total: queue.length });
    updateProgress();
    // Index shards download in parallel, a window ahead of the lookups: a big circle usually stops
    // at the growth budget long before its end, so fetching all ~1,000 up front would be wasted.
    const AHEAD = 48;
    void prefetch(queue.slice(0, AHEAD));

    // A small circle cascades in visibly (a short beat per artist). A big one (B.B. King has ~1,000
    // connections, whose own connections would add ~17,000 artists) goes as fast as it can, in
    // frame-sized slices, and stops at the growth budget: the rest waits for "one more level".
    const cascade = queue.length <= 60;
    let sliceStart = performance.now();
    let stoppedAt = queue.length;
    for (let i = 0; i < queue.length; i++) {
      if (token !== exploreToken) return; // user moved on to another artist
      if (!cascade && artistsOnMap() >= AUTO_GROWTH_ARTISTS) {
        stoppedAt = i;
        break;
      }
      if (i && i % 16 === 0) void prefetch(queue.slice(i + AHEAD - 16, i + AHEAD));
      const t = performance.now();
      await expand(queue[i], { skipHuge: true });
      if (token !== exploreToken) return; // moved on while that lookup ran
      progress.done++;
      updateProgress();
      if (cascade) {
        // Index hits are instant; a short beat lets members cascade in visibly.
        const spent = performance.now() - t;
        if (spent < 25) await new Promise((r) => setTimeout(r, 25 - spent));
      } else if (performance.now() - sliceStart > 16) {
        await new Promise((r) => requestAnimationFrame(r));
        sliceStart = performance.now();
      }
    }
    if (token !== exploreToken) return;
    progress.id = null;
    activity.clear('deep');
    if (state.selected === id) rerenderPanel();

    const stillHere = () => token === exploreToken && state.selected === id && !userCamera && !state.path;
    // Their members are in now: frame them (zoom), then keep following (pan only).
    if (stillHere()) fitNodes(oneHop(id), 800, 1.8, 1);

    // Two rings (their connections, and those connections' own) and stop: further levels are a click
    // away ("Explore one more level") instead of piling up on their own.
    if (stoppedAt < queue.length) offerNextLevel(id, queue.slice(stoppedAt), 2, queue);
    else {
      const next = nextLevel(queue);
      if (next.length) offerNextLevel(id, next, 3);
    }
    // Physics must have every newcomer before we ask whether it's at rest.
    flushNow();
    growth.done = true;
    physics.onceAtRest(() => {
      // Growth is done and the map has settled: the islands you're looking at stay put from now on.
      if (token === exploreToken) physics.lockIslands();
      if (!stillHere()) return;
      // Final framing: centered, pulled back a little after a search so their scene shows around them.
      fitNodes(oneHop(id), 900, id === state.origin ? 1.6 : 1.4, 1, id);
    });
  }

  /** The panel's "Explore their connections": everyone connected to an explored artist gets looked up. */
  let exploringChildrenOf: string | null = null;
  async function exploreChildren(id: string) {
    const frontier = nextLevel([id]);
    if (!frontier.length) return;
    track('explore: their connections');
    const token = ++exploreToken;
    nextUp = null;
    exploringChildrenOf = id;
    if (state.selected === id) rerenderPanel(); // the button goes away while it runs
    const finished = await exploreLevel(frontier, 0, token);
    if (exploringChildrenOf === id) exploringChildrenOf = null;
    if (!finished) return;
    activity.clear('deep');
    if (state.selected === id) {
      rerenderPanel();
      if (!userCamera) fitNodes(twoHops(id), 800, 1.4, 1);
    }
    flushNow();
    physics.onceAtRest(() => token === exploreToken && physics.lockIslands());
    const next = nextLevel(frontier);
    if (next.length) offerNextLevel(id, next, 0);
  }

  /** The panel's "Show connections": this artist's own connections only, then the usual offer. */
  async function expandOne(id: string) {
    track('explore: show connections');
    const token = ++exploreToken;
    activity.clear('deep');
    if (!expanded.has(id)) activity.set('load', `Loading ${nodeById.get(id)?.label ?? 'artist'}…`);
    await expand(id);
    activity.clear('load');
    if (token !== exploreToken || !expanded.has(id)) return;
    if (state.selected === id) {
      rerenderPanel();
      if (!userCamera) fitNodes(oneHop(id), 700, 1.6, 1);
    }
    flushNow();
    physics.onceAtRest(() => token === exploreToken && physics.lockIslands());
    const next = nextLevel([id]);
    if (next.length) offerNextLevel(id, next, 2);
  }

  /**
   * Keeps an artist centered while the map is still growing and settling around them (islands
   * form and drift during that time). Pans only, easing a fraction of the way each frame, so the
   * view glides instead of jumping. Stops as soon as you move the camera yourself, pick someone
   * else, or everything has come to rest.
   */
  function followArtist(id: string, token: number, growth: { done: boolean }) {
    const step = () => {
      if (token !== exploreToken || state.selected !== id || userCamera || state.path || !graph.hasNode(id)) return;
      if (growth.done && !physics.isRunning()) return; // settled: the final framing takes over
      // Don't fight a framing animation that's playing; resume right after.
      if (!camera.isAnimating()) {
        const p = renderer.graphToViewport(graph.getNodeAttributes(id) as { x: number; y: number });
        const c = freeCenter();
        const dx = p.x - c.x;
        const dy = p.y - c.y;
        if (Math.hypot(dx, dy) > 1.5) panBy(dx * 0.12, dy * 0.12);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * A search grows two levels (the artist's connections, then theirs), stopping early inside a
   * huge circle once the map has this many artists. "Explore one more level" adds one more per click.
   */
  const AUTO_GROWTH_ARTISTS = 1500;
  /** The next level waiting to be explored (shown as the button in the pill). */
  /** `base`: the whole level when `frontier` is only its unexplored rest (the next level grows from all of it). */
  let nextUp: { id: string; frontier: string[]; level: number; base?: string[] } | null = null;

  const artistsOnMap = () => graph.filterNodes((n) => nodeById.get(n)?.kind !== 'album').length;

  /** Looks up everyone in one level. Returns false if you moved on to another artist meanwhile. */
  async function exploreLevel(frontier: string[], level: number, token: number): Promise<boolean> {
    void prefetch(frontier);
    let sliceStart = performance.now();
    for (let i = 0; i < frontier.length; i++) {
      if (token !== exploreToken) return false;
      await expand(frontier[i], { indexOnly: true, skipHuge: true });
      // You may have moved on while that lookup ran: then don't touch the pill (it's someone else's now).
      if (token !== exploreToken) return false;
      // Work in ~16 ms slices (about a frame), then let the browser draw: fast, and the map stays smooth.
      if (performance.now() - sliceStart > 16) {
        await new Promise((r) => requestAnimationFrame(r));
        sliceStart = performance.now();
      }
      if (i % 4 === 0 || i === frontier.length - 1) {
        activity.set(
          'deep',
          `${level ? `Exploring level ${level}` : 'Exploring one more level'} · ${artistsOnMap().toLocaleString()} artists`,
          (i + 1) / frontier.length,
          `${(i + 1).toLocaleString()}/${frontier.length.toLocaleString()}`,
        );
      }
    }
    return token === exploreToken;
  }

  /** Pauses at a level boundary and offers the next level as a button. */
  function offerNextLevel(id: string, frontier: string[], level: number, base?: string[]) {
    nextUp = { id, frontier, level, base };
    activity.set('deep', `${artistsOnMap().toLocaleString()} artists on the map`, undefined, undefined, {
      label: `Explore one more level (+${frontier.length.toLocaleString()})`,
      onClick: exploreOneMoreLevel,
    });
  }

  function exploreOneMoreLevel() {
    if (!nextUp) return;
    track('explore: one more level');
    const { id, frontier, level, base } = nextUp;
    nextUp = null;
    const token = exploreToken;
    void (async () => {
      if (!(await exploreLevel(frontier, level, token))) return;
      if (!state.selected) return offerMapLevel(); // nothing selected: keep offering the whole map
      const next = nextLevel(base ?? frontier);
      if (next.length) offerNextLevel(id, next, level + 1);
      else activity.set('deep', `Everything connected is on the map · ${artistsOnMap().toLocaleString()} artists`, undefined, undefined, {
        label: 'OK',
        onClick: () => activity.clear('deep'),
      });
    })();
  }

  /**
   * With nothing selected, "one more level" means the whole map: every artist still shown as a
   * hollow ring gets looked up (huge collectives stay closed).
   */
  function offerMapLevel() {
    const rings = graph.filterNodes(
      (n) => !expanded.has(n) && !loading.has(n) && !collectives.has(n) && nodeById.get(n)?.kind !== 'album',
    );
    if (!rings.length || !graph.order) {
      nextUp = null;
      return;
    }
    nextUp = { id: state.origin ?? '', frontier: rings, level: 0 };
    activity.set('deep', `${artistsOnMap().toLocaleString()} artists on the map`, undefined, undefined, {
      label: `Explore one more level (+${rings.length.toLocaleString()})`,
      onClick: exploreOneMoreLevel,
    });
  }

  function nextLevel(from: string[]): string[] {
    const out = new Set<string>();
    for (const n of from) {
      if (!graph.hasNode(n)) continue;
      for (const m of graph.neighbors(n)) {
        if (!expanded.has(m) && !loading.has(m) && !collectives.has(m) && nodeById.get(m)?.kind !== 'album') out.add(m);
      }
    }
    return [...out];
  }

  /** The artist and their direct connections: what the camera frames when you pick someone. */
  function oneHop(id: string): string[] {
    if (!graph.hasNode(id)) return [id];
    return [id, ...graph.neighbors(id).filter(isNodeVisible)];
  }

  function twoHops(id: string): string[] {
    const out = new Set([id]);
    for (const n of graph.neighbors(id)) {
      if (!isNodeVisible(n)) continue;
      out.add(n);
      for (const m of graph.neighbors(n)) if (isNodeVisible(m)) out.add(m);
    }
    return [...out];
  }

  /** Updates the pill and panel as members load, unless the user is typing in the panel. */
  function updateProgress() {
    // The pill is cheap: update it now. The map and panel follow in the next batch.
    if (progress.id && progress.total) {
      const what = nodeById.get(progress.id)?.kind === 'group' ? "members' other bands" : 'bandmates';
      activity.set('deep', `${nodeById.get(progress.id)?.label}: ${what}`, progress.done / progress.total, `${progress.done}/${progress.total}`);
    }
    focusDirty = true;
    if (state.selected && state.selected === progress.id && panelDirty !== 'force') panelDirty = 'progress';
    scheduleFlush();
  }

  function progressText(id: string) {
    const kind = nodeById.get(id)?.kind;
    const what = kind === 'group' ? "members' other bands and projects" : 'who else played in these';
    return `Looking up ${what}… ${progress.done}/${progress.total}`;
  }

  /** Fetches one artist's connections and adds them to the map. */
  async function expand(id: string, opts: { indexOnly?: boolean; skipHuge?: boolean } = {}) {
    if (expanded.has(id) || loading.has(id)) return;
    if (opts.skipHuge) {
      if (collectives.has(id)) return;
      const total = await connectionCount(id);
      if (total !== null && total >= HUGE_GROUP) {
        collectives.add(id);
        return;
      }
    }
    loading.add(id);
    failed.delete(id);
    if (state.selected === id) {
      panelDirty = 'force';
      scheduleFlush();
    }
    try {
      const res = opts.indexOnly ? await fetchConnections(id, { indexOnly: true }) : await fetchConnections(id);
      if (!res) {
        expanded.add(id); // nothing more to find for this artist
        return;
      }
      const { artist, neighbors, edges } = res;
      const center = graph.hasNode(id) ? (graph.getNodeAttributes(id) as { x: number; y: number }) : undefined;
      upsertNode(
        {
          id: artist.id,
          label: artist.name,
          kind: artist.kind,
          country: artist.country,
          begin: artist.begin,
          end: artist.end,
          disambiguation: artist.disambiguation,
          wikidata: artist.wikidata,
        },
        center,
      );
      const origin = graph.getNodeAttributes(id) as { x: number; y: number };
      const fresh = neighbors.filter((n) => !graph.hasNode(n.id));
      fresh.forEach((n, i) => upsertNode(stubNode(n), origin, i, fresh.length));
      for (const n of neighbors) if (!fresh.includes(n)) upsertNode(stubNode(n));
      for (const e of edges) addEdge(e);
      resizeNodes([id, ...neighbors.map((n) => n.id)]);
      expanded.add(id);
    } catch {
      failed.add(id);
    } finally {
      loading.delete(id);
      // The sets and the graph are up to date already; the UI catches up in the next batch.
      graphDirty = true;
      focusDirty = true;
      if (state.selected === id) panelDirty = 'force';
      scheduleFlush();
    }
  }

  // ---------- Selection & history ----------

  const index: SearchIndex = {
    items: () => [...nodeById.values()].map((n) => ({ id: n.id, label: n.label, kind: n.kind, sub: n.kind === 'album' ? 'album' : 'on map' })),
    degree: (id) => (graph.hasNode(id) ? graph.degree(id) : 0),
  };

  const ctx: PanelContext = {
    graph,
    node: (id) => nodeById.get(id)!,
    edge: (id) => edgeById.get(id)!,
    isEdgeVisible,
    index,
    status: (id) => (loading.has(id) ? 'loading' : failed.has(id) ? 'error' : expanded.has(id) ? 'done' : 'idle'),
    progress: (id) => (progress.id === id ? progressText(id) : null),
    expand: (id) => void expandOne(id),
    unexplored: (id) => (exploringChildrenOf === id ? 0 : nextLevel([id]).length),
    exploreChildren: (id) => void exploreChildren(id),
    albums: fetchAlbums,
    count: connectionCount,
    inChainView: () => state.connectView,
    exploreFrom: (id) => exploreFrom(id),
    hue: (id) => (nodeById.has(id) ? hueOf(id, nodeById.get(id)!.kind) : theme.muted),
    select: (id) => select(id),
    peek: (id) => {
      if (state.peek === id) return;
      state.peek = id;
      renderer.refresh({ skipIndexation: true });
    },
    trail: () => state.trail.filter((id) => nodeById.has(id)),
    collapse: () => setCollapsed(true),
    connect: (from, to) => {
      const p = findPath(graph, from, to, isEdgeVisible);
      if (!p) return null;
      state.path = p;
      refresh();
      rerenderPanel();
      fitNodes(p.nodes);
      return p;
    },
  };

  /**
   * Focuses an artist (or clears focus with null). Each pick is a browser history entry, so the
   * back/forward buttons and gestures walk through what you've looked at.
   */
  function select(id: string | null, opts: { push?: boolean; move?: boolean; explore?: boolean } = {}) {
    const { push = true } = opts;
    // In the connection view a click just focuses that step: no growth, the camera and chain stay.
    const inChain = state.connectView;
    const move = inChain ? false : (opts.move ?? true);
    // Picking someone only focuses them; growing the map is always asked for (search, a link, a button).
    const grow = inChain ? false : (opts.explore ?? false);
    const next = id && graph.hasNode(id) ? id : null;
    if (next !== state.selected) userCamera = false;
    state.selected = next;
    state.path = inChain ? state.chain : null;
    state.peek = null;
    if (next) {
      state.trail = [...state.trail.filter((x) => x !== next), next].slice(-8);
      setCollapsed(false, false);
    }
    // Right away, with any pending map updates folded in: the panel and camera need current state.
    focusDirty = true;
    panelDirty = 'force';
    flushNow();
    updateReopen();

    const hash = next ? `#${next}` : '';
    if (location.hash !== hash) {
      const url = next ? hash : location.pathname + location.search;
      if (push) history.pushState({ id: next }, '', url);
      else history.replaceState({ id: next }, '', url);
    }

    if (!next) {
      exploreToken++; // stop lookups for the previous artist
      progress.id = null;
      activity.clear('load');
      activity.clear('deep');
      // Nothing selected: you can still grow the whole map by one level (not in the calm chain view).
      if (!inChain) offerMapLevel();
      return;
    }
    if (move) fitNodes(oneHop(next), 700, 1.8, 1);
    if (!grow || nodeById.get(next)!.kind === 'album') return;
    void explore(next);
  }

  /** Leaves the connection view and explores outward from this artist (the panel's button). */
  function exploreFrom(id: string) {
    if (state.connectView) {
      state.connectView = false;
      state.chain = null;
      physics.releaseHeld();
      scenes.schedule(); // scene islands come back
    }
    state.origin = id;
    select(id, { explore: true });
  }

  /** Focuses an artist that may not be on the map yet (search result, suggestion, shared link). */
  async function openArtist(item: { id: string; label: string; kind: ExportNode['kind'] }, push = true) {
    state.origin = item.id; // a search / suggestion / link sets the starting point
    if (!graph.hasNode(item.id)) {
      upsertNode({ id: item.id, label: item.label, kind: item.kind });
      graphDirty = true; // select() below flushes it
    }
    select(item.id, { push, explore: true });
  }

  // ---------- Panel collapse ----------

  const reopen = $<HTMLButtonElement>('panel-reopen');
  function setCollapsed(on: boolean, refit = true) {
    document.body.classList.toggle('panel-collapsed', on);
    updateReopen();
    if (refit && state.selected && !userCamera) fitNodes(oneHop(state.selected), 500, 1.8, 1);
  }
  function updateReopen() {
    const collapsed = document.body.classList.contains('panel-collapsed');
    reopen.hidden = !(collapsed && state.selected);
    reopen.textContent = state.selected ? `‹ ${nodeById.get(state.selected)?.label ?? 'Details'}` : '';
  }
  reopen.addEventListener('click', () => setCollapsed(false));

  // ---------- Camera ----------

  /** Middle of the part of the map not covered by the panel (right side on wide screens, bottom on phones). */
  function freeCenter() {
    const { width: w, height: hgt } = renderer.getDimensions();
    const narrow = window.innerWidth <= 640;
    const panelShown = panel.offsetWidth > 0 && !panel.hidden;
    const right = w - (panelShown && !narrow ? panel.offsetWidth + 40 : 24);
    const bottom = hgt - (panelShown && narrow ? panel.offsetHeight + 16 : 40);
    return { x: (24 + right) / 2, y: (80 + bottom) / 2 };
  }

  /** Animates the camera to frame the given nodes in the area the panel leaves free. */
  function fitNodes(ids: string[], duration = 600, padding = 1.25, minRatio = 0, centerOn?: string) {
    // Node positions come from sigma's display data, which only updates on refresh: flush first.
    flushNow();
    const pts = ids.map((id) => renderer.getNodeDisplayData(id)).filter((d): d is NonNullable<typeof d> => !!d);
    if (!pts.length) return;
    const cam = renderer.getCamera();
    const st = cam.getState();
    const { width: w, height: hgt } = renderer.getDimensions();

    // Where the nodes are on screen right now (with the real, current camera).
    const screen = pts.map((p) => renderer.framedGraphToViewport(p));
    const xs = screen.map((p) => p.x);
    const ys = screen.map((p) => p.y);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    // Zoom fits the whole box; the view centers on the box, or exactly on one artist if asked.
    const focusPt = centerOn ? renderer.getNodeDisplayData(centerOn) : undefined;
    const boxCenter = focusPt
      ? renderer.framedGraphToViewport(focusPt)
      : { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    if (focusPt) {
      // Keep the whole box visible around an off-center point: size it from the point outward.
      const half = Math.max(boxCenter.x - box.x0, box.x1 - boxCenter.x);
      const halfY = Math.max(boxCenter.y - box.y0, box.y1 - boxCenter.y);
      box.x0 = boxCenter.x - half;
      box.x1 = boxCenter.x + half;
      box.y0 = boxCenter.y - halfY;
      box.y1 = boxCenter.y + halfY;
    }

    // Free area: the panel covers the right side on wide screens and the bottom on phones.
    const narrow = window.innerWidth <= 640;
    const panelShown = panel.offsetWidth > 0 && !panel.hidden;
    const free = {
      left: 24,
      top: 80,
      right: w - (panelShown && !narrow ? panel.offsetWidth + 40 : 24),
      bottom: hgt - (panelShown && narrow ? panel.offsetHeight + 16 : 40),
    };
    const freeW = Math.max(80, free.right - free.left);
    const freeH = Math.max(80, free.bottom - free.top);
    const freeCenter = { x: (free.left + free.right) / 2, y: (free.top + free.bottom) / 2 };

    // Zoom so the box fills ~80% of the free area. Screen size scales linearly with the ratio.
    const k = Math.max((box.x1 - box.x0) / freeW, (box.y1 - box.y0) / freeH) * padding;
    let ratio = k > 0 ? st.ratio * k : st.ratio;
    if (pts.length < 3) ratio = Math.max(ratio, 1); // a lone node isn't blown up
    ratio = Math.max(ratio, minRatio);
    ratio = cam.getBoundedRatio(ratio);

    // Pan so the box center sits at the free area's center, then zoom around that point.
    const a = renderer.viewportToFramedGraph(boxCenter);
    const b = renderer.viewportToFramedGraph(freeCenter);
    const panned = { ...st, x: st.x + (a.x - b.x), y: st.y + (a.y - b.y) };
    const p = renderer.viewportToFramedGraph(freeCenter, { cameraState: panned });
    const f = ratio / st.ratio;
    cam.animate({ x: p.x + (panned.x - p.x) * f, y: p.y + (panned.y - p.y) * f, ratio }, { duration, easing: 'cubicInOut' });
  }

  // ---------- Navigation ----------
  // Trackpad/scroll wheel pans; pinch or Ctrl/⌘ + scroll zooms at the pointer; drag pans.
  // Any of these hands the camera to you: it won't move on its own until you pick another artist.

  let userCamera = false;
  const camera = renderer.getCamera();

  function panBy(dx: number, dy: number) {
    const a = renderer.viewportToFramedGraph({ x: 0, y: 0 });
    const b = renderer.viewportToFramedGraph({ x: dx, y: dy });
    const st = camera.getState();
    camera.setState({ x: st.x + (b.x - a.x), y: st.y + (b.y - a.y) });
  }

  function zoomAt(point: { x: number; y: number }, factor: number, animate = false) {
    const ratio = camera.getBoundedRatio(camera.getState().ratio * factor);
    const next = renderer.getViewportZoomedState(point, ratio);
    if (animate) void camera.animate(next, { duration: 250, easing: 'quadraticOut' });
    else camera.setState(next);
  }

  const takeCamera = () => {
    userCamera = true;
    if (camera.isAnimating()) camera.cancelAnimation();
  };

  renderer.getMouseCaptor().on('wheel', (e) => {
    e.preventSigmaDefault();
    const ev = e.original as WheelEvent;
    ev.preventDefault();
    takeCamera();
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? window.innerHeight : 1;
    if (ev.ctrlKey || ev.metaKey) zoomAt({ x: e.x, y: e.y }, Math.exp(ev.deltaY * unit * 0.01));
    else panBy(ev.deltaX * unit, ev.deltaY * unit);
  });
  container.addEventListener('pointerdown', takeCamera);
  container.addEventListener('touchstart', takeCamera, { passive: true });

  const viewCenter = () => {
    const { width, height } = renderer.getDimensions();
    return { x: width / 2, y: height / 2 };
  };
  const zoomIn = () => (takeCamera(), zoomAt(viewCenter(), 1 / 1.5, true));
  const zoomOut = () => (takeCamera(), zoomAt(viewCenter(), 1.5, true));
  const fitAll = () => fitNodes(graph.filterNodes((n) => isNodeVisible(n)), 700);
  $<HTMLButtonElement>('zoom-in').addEventListener('click', zoomIn);
  $<HTMLButtonElement>('zoom-out').addEventListener('click', zoomOut);
  $<HTMLButtonElement>('zoom-fit').addEventListener('click', fitAll);

  /** Back to the artist you searched for: centered, a little zoomed out (camera only). */
  function goHome() {
    if (!state.origin || !graph.hasNode(state.origin)) return;
    takeCamera(); // stop any follow; this is a deliberate move
    fitNodes(oneHop(state.origin), 600, 1.6, 1, state.origin);
  }
  $<HTMLButtonElement>('zoom-home').addEventListener('click', goHome);

  // Keyboard: arrows pan, +/- zoom, 0 fits, / searches, Esc steps back out.
  const held = new Set<string>();
  let keyFrame = 0;
  const keyStep = () => {
    keyFrame = 0;
    if (!held.size) return;
    const speed = 12;
    const dx = (held.has('ArrowRight') ? speed : 0) - (held.has('ArrowLeft') ? speed : 0);
    const dy = (held.has('ArrowDown') ? speed : 0) - (held.has('ArrowUp') ? speed : 0);
    panBy(dx, dy);
    keyFrame = requestAnimationFrame(keyStep);
  };
  const typing = () => {
    const t = document.activeElement?.tagName;
    return t === 'INPUT' || t === 'TEXTAREA';
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && typing()) {
      (document.activeElement as HTMLElement).blur();
      return;
    }
    if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      takeCamera();
      held.add(e.key);
      if (!keyFrame) keyFrame = requestAnimationFrame(keyStep);
    } else if (e.key === '+' || e.key === '=') zoomIn();
    else if (e.key === '-' || e.key === '_') zoomOut();
    else if (e.key === '0') fitAll();
    else if (e.key === 'h' || e.key === 'H') goHome();
    else if (e.key === 'Escape') {
      if (state.path) {
        state.path = null;
        refresh();
        rerenderPanel();
      } else {
        select(null);
        fitAll();
      }
    }
  });
  document.addEventListener('keyup', (e) => held.delete(e.key));
  window.addEventListener('blur', () => held.clear());

  // ---------- Dragging nodes ----------
  // The node follows the pointer and the rest of the map reacts live; let go and it settles.

  renderer.on('nodeDragStart', ({ node }) => {
    takeCamera();
    flushNow(); // physics must know the node (it may have arrived this frame)
    physics.dragStart(node);
  });
  renderer.on('nodeDrag', ({ node }) => {
    const a = graph.getNodeAttributes(node) as { x: number; y: number };
    physics.dragMove(node, a.x, a.y);
  });
  renderer.on('nodeDragEnd', ({ node }) => physics.dragEnd(node));

  // ---------- Layout menu ----------

  mountLayoutControls(
    $<HTMLDivElement>('layout-controls'),
    prefs,
    () => {
      flushNow(); // new settings apply to every node on the map, including ones not synced yet
      physics.applyPrefs(true);
      if (prefs.paused) physics.stop();
      else physics.start();
    },
    () => {
      flushNow();
      physics.rerun();
    },
  );

  // ---------- Pointer ----------

  // A click focuses (highlight + panel) without moving the camera or growing the map.
  renderer.on('clickNode', ({ node }) => select(node, { move: false }));
  // A click in empty space picks the nearest artist if one is close (the one whose name is showing).
  renderer.on('clickStage', () => (state.hovered ? select(state.hovered, { move: false }) : select(null)));
  renderer.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
    // Double-click zooms in on that artist's neighborhood instead of sigma's plain zoom.
    preventSigmaDefault();
    takeCamera();
    fitNodes([node, ...graph.neighbors(node).filter(isNodeVisible)], 500);
  });
  // Hover chip: the hovered artist's label, richer than a map label can be.
  const chip = h('div', { class: 'hover-chip', hidden: true });
  container.after(chip);
  /** Connection totals for the chip (null = unknown yet); filled in the background. */
  const hoverCounts = new Map<string, number | null>();

  function fillChip(id: string) {
    const n = nodeById.get(id);
    if (!n) return;
    const meta =
      n.kind === 'album' ? ['album', n.year] : [n.kind === 'group' ? 'band' : 'person', n.country, years(n.begin, n.end)];
    const onMap = graph.hasNode(id) ? graph.degree(id) : 0;
    if (n.kind !== 'album' && !hoverCounts.has(id)) {
      hoverCounts.set(id, null);
      void connectionCount(id).then((c) => {
        hoverCounts.set(id, c);
        if (state.hovered === id) fillChip(id);
      });
    }
    const total = hoverCounts.get(id);
    const more = total != null ? total - onMap : 0;
    chip.replaceChildren(
      h('span', { class: 'dot', style: `background:${hueOf(id, n.kind)}` }),
      h('span', { class: 'name' }, n.label),
      h('span', { class: 'meta' }, meta.filter(Boolean).join(' · ')),
      ...(more > 0 ? [h('span', { class: 'more' }, `+${more.toLocaleString()}`)] : []),
    );
    placeChip();
  }

  /** Puts the chip where the hovered node's label would be: just right of the node, centered on it. */
  function placeChip() {
    const id = state.hovered;
    if (!id || !graph.hasNode(id) || !isNodeVisible(id)) return void (chip.hidden = true);
    const p = renderer.graphToViewport(graph.getNodeAttributes(id) as { x: number; y: number });
    const ratio = camera.getState().ratio;
    const radius = (renderer.getNodeDisplayData(id)?.size ?? 6) / (ratio < 1 ? 1 : Math.sqrt(ratio));
    chip.hidden = false;
    const { width } = renderer.getDimensions();
    let x = p.x + radius + 6;
    // Near the right edge, flip to the left of the node.
    if (x + chip.offsetWidth > width - 8) x = p.x - radius - 6 - chip.offsetWidth;
    chip.style.transform = `translate(${Math.round(x)}px, ${Math.round(p.y - chip.offsetHeight / 2)}px)`;
  }
  // Follow the node every frame while the chip shows (the map pans, zooms and settles under it).
  let chipFrame = 0;
  const followChip = () => {
    chipFrame = 0;
    placeChip();
    if (!chip.hidden) chipFrame = requestAnimationFrame(followChip);
  };
  renderer.on('afterRender', () => {
    placeChip();
    if (!chip.hidden && !chipFrame) chipFrame = requestAnimationFrame(followChip);
  });

  // Hover snaps to the nearest artist within SNAP_PX of the pointer, not only the one exactly under
  // it: small dots are hard to hit, and you shouldn't have to aim to read a name.
  const SNAP_PX = 24;
  let exactHover: string | null = null;
  let pointer: { x: number; y: number } | null = null;
  let pointerDown = false;
  let hoverFrame = 0;

  function setHovered(node: string | null) {
    if (node === state.hovered) return;
    state.hovered = node;
    container.style.cursor = node ? 'pointer' : '';
    if (node) {
      fillChip(node);
      if (!chipFrame) chipFrame = requestAnimationFrame(followChip);
    } else chip.hidden = true;
    refresh();
  }

  function nearestNode(): string | null {
    if (!pointer) return null;
    // Rendered radius: sizes are in screen pixels, shrunk when zoomed out (zoomToSizeRatioFunction).
    const ratio = camera.getState().ratio;
    const shrink = ratio < 1 ? 1 : Math.sqrt(ratio);
    let best: string | null = null;
    let bestGap = SNAP_PX;
    graph.forEachNode((n, a) => {
      if (!isNodeVisible(n)) return;
      const d = renderer.getNodeDisplayData(n);
      if (!d) return;
      const p = renderer.graphToViewport(a as { x: number; y: number });
      const gap = Math.hypot(p.x - pointer!.x, p.y - pointer!.y) - d.size / shrink;
      if (gap < bestGap) {
        bestGap = gap;
        best = n;
      }
    });
    return best;
  }

  const scheduleHover = () => {
    if (!hoverFrame) hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      if (!pointerDown) setHovered(exactHover ?? nearestNode());
    });
  };
  // The map moving under a still pointer (trackpad pan, scroll, zoom, a camera animation) changes
  // what's nearest: look again, so the hover stays with the pointer instead of riding along with
  // the map. While you drag the map itself, there's no hover at all.
  camera.on('updated', () => {
    if (pointerDown) {
      exactHover = null;
      setHovered(null);
    } else if (pointer) scheduleHover();
  });
  container.addEventListener('pointermove', (e) => {
    const r = container.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    scheduleHover();
  });
  container.addEventListener('pointerdown', () => (pointerDown = true));
  window.addEventListener('pointerup', () => {
    pointerDown = false;
    scheduleHover();
  });
  container.addEventListener('pointerleave', () => {
    pointer = null;
    exactHover = null;
    setHovered(null);
  });
  renderer.on('enterNode', ({ node }) => {
    exactHover = node;
    setHovered(node);
  });
  renderer.on('leaveNode', () => {
    exactHover = null;
    scheduleHover();
  });

  // ---------- Search ----------

  attachSearch(
    searchInput,
    $<HTMLUListElement>('search-list'),
    index,
    (item: SearchItem) => {
      if (item.kind === 'album') state.edgeTypes.add('released');
      syncFilters();
      void openArtist(item);
    },
    {
      onBusy: (busy) => (busy ? activity.set('search', 'Searching MusicBrainz…') : activity.clear('search')),
      remote: async (q) => (await searchArtists(q)).map((a) => ({ id: a.id, label: a.name, kind: a.kind, sub: a.sub, remote: true })),
    },
  );

  // ---------- Connect two artists ----------
  // Any two artists, even if neither is on the map: search outward from both over the index,
  // then put the chain on the map and highlight it.

  const connectMenu = document.querySelector<HTMLDetailsElement>('details.connect-menu')!;
  let connectSearch: { cancelled: boolean } | null = null;
  const connectUI = mountConnect($<HTMLDivElement>('connect-controls'), {
    index,
    remote: async (q) => (await searchArtists(q)).map((a) => ({ id: a.id, label: a.name, kind: a.kind, sub: a.sub, remote: true })),
    onFind: (a, b) => void connectArtists(a, b),
  });
  // Opening the menu pre-fills "From" with whoever you're looking at.
  connectMenu.addEventListener('toggle', () => {
    const cur = state.selected ?? state.origin;
    if (connectMenu.open && cur && nodeById.has(cur)) {
      const n = nodeById.get(cur)!;
      connectUI.setFrom({ id: n.id, label: n.label, kind: n.kind });
    }
  });

  async function connectArtists(a: SearchItem, b: SearchItem) {
    track(`connect: ${a.label} → ${b.label}`);
    connectMenu.open = false;
    if (connectSearch) connectSearch.cancelled = true;
    const signal = (connectSearch = { cancelled: false });
    exploreToken++; // pause any growth so the search has the downloads to itself
    progress.id = null;
    activity.clear('deep');
    activity.set('load', `Finding how ${a.label} and ${b.label} are connected…`);
    const res = await findConnection(a.id, b.id, {
      signal,
      onProgress: (p) => activity.set('load', `Finding a connection · ${p.depth} steps out`, undefined, `${p.checked.toLocaleString()} artists checked`),
    });
    if (signal !== connectSearch || res === 'cancelled') return;
    activity.clear('load');
    if (!res) {
      activity.set('deep', `No connection found between ${a.label} and ${b.label} within ${MAX_STEPS} steps`, undefined, undefined, {
        label: 'OK',
        onClick: () => activity.clear('deep'),
      });
      return;
    }

    // A clean view of just the chain: fresh map, artists left to right in order (slight zigzag so
    // labels don't collide). Each step stays a hollow ring: click one to explore from there.
    clearMap();
    state.connectView = true;
    // Top to bottom, one step per row with a gentle zigzag: names extend to the right and can
    // never collide, however long they are (and it fits the tall space beside the panel).
    // Held in place: in this view the chain's shape matters more than physics.
    const rowGap = 80;
    res.nodes.forEach((id, i) => {
      const known = res.info.get(id) ?? (id === a.id ? { name: a.label, kind: a.kind } : { name: b.label, kind: b.kind });
      upsertNode({ id, label: known.name, kind: known.kind as ExportNode['kind'] });
      // sigma's y axis points up, so the first step goes on top.
      graph.mergeNodeAttributes(id, { x: i % 2 ? 60 : -60, y: ((res.nodes.length - 1) / 2 - i) * rowGap });
    });
    for (const e of res.edges) addEdge(e);
    resizeNodes(res.nodes);
    graphDirty = true;
    flushNow();
    physics.hold(res.nodes);

    // A little context: up to 3 landmarks per step (its best-connected neighbours, e.g. the
    // main band a person was in), not everyone. Steps stay hollow rings: click one to explore it.
    activity.set('load', 'Adding a little context…');
    const onChain = new Set(res.nodes);
    const context: string[] = [];
    for (const id of res.nodes) {
      if (signal !== connectSearch) return;
      const conn = await fetchConnections(id, { indexOnly: true }).catch(() => null);
      if (!conn) continue;
      const candidates = conn.neighbors.filter((n) => !onChain.has(n.id)).slice(0, 60);
      const counts = await Promise.all(candidates.map((n) => connectionCount(n.id)));
      const picks = candidates
        .map((n, i) => ({ n, c: counts[i] ?? 0 }))
        .filter((x) => x.c > 1 && x.c < HUGE_GROUP) // skip one-off credits and huge collectives
        .sort((x, y) => y.c - x.c)
        .slice(0, 3);
      // Fanned out to the left of the step, away from its name (names extend to the right).
      const at = graph.getNodeAttributes(id) as { x: number; y: number };
      picks.forEach(({ n }, i) => {
        const fresh = !graph.hasNode(n.id);
        upsertNode(stubNode(n), at);
        if (fresh) {
          const angle = Math.PI * (0.75 + (0.5 * (i + 0.5)) / picks.length); // between 135° and 225°
          graph.mergeNodeAttributes(n.id, { x: at.x + Math.cos(angle) * 42, y: at.y + Math.sin(angle) * 42 });
        }
        const e = conn.edges.find((ed) => ed.source === n.id || ed.target === n.id);
        if (e) addEdge(e);
      });
      resizeNodes(picks.map((p) => p.n.id));
      context.push(...picks.map((p) => p.n.id));
    }
    activity.clear('load');
    graphDirty = true;
    flushNow();
    physics.hold(context); // the whole view is a still picture until you explore from a step
    scenes.recompute(); // colors for the chain (no islands in this view)

    // Show it: start artist selected (no growth), the chain highlighted, camera on the whole chain.
    state.origin = a.id;
    state.chain = { nodes: res.nodes, edges: res.edges.map((e) => e.id) };
    select(a.id, { move: false, explore: false });
    state.chain = { nodes: res.nodes, edges: res.edges.map((e) => e.id) };
    state.path = state.chain;
    refresh();
    rerenderPanel();
    fitNodes(res.nodes, 800, 1.2, 0.6);
  }

  // ---------- Filters ----------

  const filterList = $<HTMLDivElement>('filter-list');
  const boxes = new Map<EdgeType, HTMLInputElement>();
  for (const type of Object.keys(EDGE_LABEL) as EdgeType[]) {
    const box = h('input', {
      type: 'checkbox',
      checked: state.edgeTypes.has(type),
      onchange: () => {
        if (box.checked) state.edgeTypes.add(type);
        else state.edgeTypes.delete(type);
        if (state.selected && !isNodeVisible(state.selected)) select(null);
        else {
          state.path = null;
          refresh();
          rerenderPanel();
        }
      },
    });
    boxes.set(type, box);
    filterList.append(h('label', null, box, EDGE_LABEL[type]));
  }
  function syncFilters() {
    for (const [type, box] of boxes) box.checked = state.edgeTypes.has(type);
  }

  // Menus close when you click elsewhere.
  document.addEventListener('pointerdown', (e) => {
    for (const d of document.querySelectorAll<HTMLDetailsElement>('details.filters[open]')) {
      if (!d.contains(e.target as Node)) d.open = false;
    }
  });

  $<HTMLButtonElement>('reset').addEventListener('click', () => {
    clearMap();
    searchInput.focus();
  });

  /** Empties the map and everything derived from it. */
  function clearMap() {
    // Pending updates are for the map we're about to clear: drop them instead of syncing it into physics.
    discardFlush();
    physics.clear();
    scenes.clear();
    activity.clearAll();
    nextUp = null;
    state.trail = [];
    state.origin = null;
    select(null);
    graph.clear();
    nodeById.clear();
    edgeById.clear();
    expanded.clear();
    failed.clear();
    collectives.clear();
    nextUp = null;
    activity.clear('deep'); // the deselect above offered a level for the map that's now gone
    state.connectView = false;
    state.chain = null;
    showEmpty();
  }

  // ---------- Misc ----------

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    theme = readTheme();
    refresh();
    if (state.selected) rerenderPanel();
  });

  // Links and history: #<musicbrainz-id> opens that artist, fetching it if it isn't on the map.
  const fromHash = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) {
      if (state.selected) select(null, { push: false });
      return;
    }
    if (!/^[0-9a-f-]{36}$/.test(id) || id === state.selected) return;
    void openArtist(nodeById.get(id) ?? { id, label: '…', kind: 'person' }, false);
  };
  window.addEventListener('popstate', fromHash);
  window.addEventListener('hashchange', fromHash);
  fromHash();
}

boot().catch((err) => {
  status.hidden = false;
  status.textContent = String(err instanceof Error ? err.message : err);
});
