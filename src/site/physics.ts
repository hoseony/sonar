// Interactive physics for the map (d3-force), in the spirit of Obsidian's graph view.
//
// The simulation "cools" (alpha decays) and stops completely once things settle, so nothing
// drifts or wiggles at rest. It only wakes up when something changes: new artists arrive,
// you drag a node, or you move a force slider.
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type Graph from 'graphology';
import type { LayoutPrefs } from './layout-controls.ts';

interface SimNode extends SimulationNodeDatum {
  id: string;
}
type SimLink = SimulationLinkDatum<SimNode> & { id: string };

/** How much "energy" each kind of change adds. Higher = more movement before it settles. */
const HEAT = {
  arrivals: 0.3,
  settings: 0.5,
  rerun: 0.9,
  drag: 0.25,
};

/**
 * Stability vs. layout quality knobs (tuned with a benchmark on a real 2,000-artist scene).
 * - mobileHops: during arrivals, nodes within this many links of a newcomer may move (to make
 *   room); everything farther away is held still.
 * - releaseAlpha / afterReleaseAlpha: once arrivals stop and things calm below releaseAlpha, the
 *   held nodes are let go with this much energy for one final settle.
 */
export const TUNING = {
  mobileHops: 0,
  releaseAlpha: 0.03,
  afterReleaseAlpha: 0.02,
  /** Same, when newcomers joined a map that was already at rest. */
  calmAfterReleaseAlpha: 0.006,
  /** Repulsion only reaches this far (× link distance): stops big scenes from inflating. */
  repelReach: 12,
  /** How hub links are weakened: 'min' = 1/degree (d3 default), 'sqrt' = 1/√degree (holds big bands together). */
  hubLinks: 'sqrt' as 'min' | 'sqrt',
  /** How fast the simulation cools (d3 default 0.0228). Lower = more steps to converge. */
  alphaDecay: 0.016,
  /**
   * Repulsion of an artist with a single connection, relative to a well-connected one. Below 1,
   * members who only belong to one band tuck in around it instead of inflating a giant disc.
   */
  leafRepel: 0.1,
  /** Extra push for well-connected artists (× √degree, capped), so busy parts of the map get room. */
  hubRepel: 1,
  /** How strongly an artist is pulled toward its scene's anchor (× the Center force slider / 0.04). */
  scenePull: 0.12,
  /** Empty space kept between scene islands, in px. */
  sceneGap: 160,
  /** Strength of links between different scenes, relative to links inside a scene. */
  crossSceneLinks: 0.15,
  /** Frames a scene takes to glide to its island when scenes are (re)laid out (~0.7 s). */
  glideFrames: 42,
};

/** Fastest a node may move per tick (px). Stops explosions and jitter in crowded spots. */
const MAX_SPEED = 10;

/** A force that caps every node's velocity. Runs after the other forces. */
function speedLimit() {
  let nodes: SimNode[] = [];
  const force = () => {
    for (const n of nodes) {
      const vx = n.vx ?? 0;
      const vy = n.vy ?? 0;
      const v = Math.hypot(vx, vy);
      if (v > MAX_SPEED) {
        n.vx = (vx / v) * MAX_SPEED;
        n.vy = (vy / v) * MAX_SPEED;
      }
    }
  };
  force.initialize = (ns: SimNode[]) => {
    nodes = ns;
  };
  return force;
}

export class Physics {
  private sim = forceSimulation<SimNode, SimLink>([])
    .stop() // we drive ticks ourselves from requestAnimationFrame
    .velocityDecay(0.55) // damping: higher = calmer, less overshoot
    .alphaMin(0.002);

  private nodes = new Map<string, SimNode>();
  private links = new Map<string, SimLink>();
  private dirty = false;
  private frame = 0;
  private dragging: string | null = null;
  private restListeners: (() => void)[] = [];
  /**
   * Nodes held in place while newcomers arrive, so the part of the map you're looking at doesn't
   * shift. Released once things calm down (see RELEASE_ALPHA).
   */
  private arrivalPins = new Set<SimNode>();
  /** Nodes held in place on purpose (see hold) — arrivals never release these. */
  private held = new Set<SimNode>();
  /**
   * True when newcomers arrived on a map that had already come to rest: then the final settle
   * is just a nudge, so the view you were looking at stays put.
   */
  private calmRelease = false;

  /** Which scene (community) each artist is in, and where each scene's island sits. */
  private sceneOf: (id: string) => number | undefined = () => undefined;
  /** artist → stable island key (survives community recomputes) */
  private islandOf = new Map<string, number>();
  private nextIsland = 0;
  /** island key → where that island sits */
  private anchors = new Map<number, { x: number; y: number }>();
  /**
   * Locked islands never move again (see lockIslands). Islands still forming during active growth
   * can adjust; new scenes are placed in free space around the locked ones.
   */
  private settledIslands = new Set<number>();
  /** Scenes sliding as a group to their island: remaining offset and frames. */
  private glides = new Map<number, { dx: number; dy: number; frame: number }>();

  constructor(
    private graph: Graph,
    private prefs: LayoutPrefs,
  ) {
    this.applyPrefs();
  }

  /** True while the simulation is moving things. */
  isRunning() {
    return this.frame !== 0;
  }

  /** Calls `fn` once, the next time the simulation comes to rest. */
  onceAtRest(fn: () => void) {
    if (!this.isRunning()) return fn();
    this.restListeners.push(fn);
  }

  /**
   * Brings new nodes and edges from the graph into the simulation. Settled nodes are pinned while
   * the newcomers find their place, so the existing layout stays put.
   */
  sync() {
    const hadNodes = this.nodes.size > 0;
    const wasResting = !this.isRunning();
    const fresh = new Set<string>();
    this.graph.forEachNode((id, a) => {
      if (this.nodes.has(id)) return;
      this.nodes.set(id, { id, x: a.x as number, y: a.y as number });
      fresh.add(id);
      this.dirty = true;
    });
    if (hadNodes && fresh.size) {
      if (wasResting && !this.arrivalPins.size) this.calmRelease = true;
      // Nodes near the newcomers stay free to make room; everything farther away is held.
      const mobile = new Set(fresh);
      let ring = [...fresh];
      for (let hop = 0; hop < TUNING.mobileHops; hop++) {
        const next: string[] = [];
        for (const id of ring) {
          for (const m of this.graph.neighbors(id)) {
            if (mobile.has(m)) continue;
            mobile.add(m);
            next.push(m);
            const pinned = this.nodes.get(m);
            if (pinned && this.arrivalPins.has(pinned)) {
              pinned.fx = null;
              pinned.fy = null;
              this.arrivalPins.delete(pinned);
            }
          }
        }
        ring = next;
      }
      for (const n of this.nodes.values()) {
        if (mobile.has(n.id) || n.id === this.dragging || n.fx != null) continue;
        n.fx = n.x;
        n.fy = n.y;
        n.vx = 0;
        n.vy = 0;
        this.arrivalPins.add(n);
      }
    }
    this.graph.forEachEdge((id, _a, s, t) => {
      if (this.links.has(id)) return;
      this.links.set(id, { id, source: s, target: t });
      this.dirty = true;
    });
    if (this.dirty) this.heat(HEAT.arrivals);
  }

  /** Lets go of nodes held during arrivals (they keep their positions). */
  private releasePins() {
    for (const n of this.arrivalPins) {
      if (n.id === this.dragging) continue;
      n.fx = null;
      n.fy = null;
    }
    this.arrivalPins.clear();
  }

  clear() {
    this.held.clear();
    this.anchors.clear();
    this.settledIslands.clear();
    this.islandOf.clear();
    this.glides.clear();
    this.arrivalPins.clear();
    this.calmRelease = false;
    this.nodes.clear();
    this.links.clear();
    this.sim.nodes([]);
    (this.sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>>).links([]);
    this.stop();
  }

  /** Re-reads the force sliders and wakes the simulation so the change is visible. */
  applyPrefs(heat = false) {
    const p = this.prefs;
    // Forces are rebuilt below and immediately look up nodes by id: give the simulation the
    // current node list first (newcomers may not be attached yet).
    this.sim.nodes([...this.nodes.values()]);
    const degree = (n: SimNode | string | number) => {
      const id = typeof n === 'object' ? n.id : String(n);
      return this.graph.hasNode(id) ? this.graph.degree(id) : 1;
    };
    this.sim
      .force(
        'link',
        forceLink<SimNode, SimLink>([...this.links.values()])
          .id((d) => d.id)
          // Links between different scenes are longer and weaker, so they don't drag islands together.
          .distance((l) => (this.crossScene(l) ? p.linkDistance * 3 : p.linkDistance))
          // d3's default: weaker pull on hubs, so a band with 60 members doesn't crush them together.
          .strength((l) => {
            const d = Math.max(1, Math.min(degree(l.source), degree(l.target)));
            const k = p.linkForce / (TUNING.hubLinks === 'sqrt' ? Math.sqrt(d) : d);
            return this.crossScene(l) ? k * TUNING.crossSceneLinks : k;
          }),
      )
      .force(
        'charge',
        forceManyBody<SimNode>()
          .strength((d) => {
            const deg = degree(d);
            // Leaves push less; artists with 3+ connections push at full strength.
            let k = deg >= 3 ? 1 : TUNING.leafRepel + (1 - TUNING.leafRepel) * ((deg - 1) / 2);
            if (deg >= 3 && TUNING.hubRepel > 0) k *= Math.min(4, 1 + TUNING.hubRepel * (Math.sqrt(deg) - 1));
            return -p.repel * k;
          })
          .theta(0.8) // accuracy of the far-field approximation (lower = steadier)
          .distanceMax(Math.max(150, p.linkDistance * TUNING.repelReach)), // far-away clusters don't push each other forever
      )
      .force('x', forceX<SimNode>((d) => this.anchorOf(d.id)?.x ?? 0).strength((d) => this.pullOf(d.id)))
      .force('y', forceY<SimNode>((d) => this.anchorOf(d.id)?.y ?? 0).strength((d) => this.pullOf(d.id)))
      .force(
        'collide',
        p.noOverlap
          ? forceCollide<SimNode>((d) => ((this.graph.getNodeAttribute(d.id, 'size') as number) ?? 4) + 3).strength(0.7)
          : null,
      )
      // Always last, so it caps the combined result of every other force.
      .force('limit', null)
      .force('limit', speedLimit());
    this.sim.alphaDecay(TUNING.alphaDecay);
    this.dirty = true;
    if (heat) {
      this.releasePins(); // a slider change should affect the whole map
      this.heat(HEAT.settings);
    }
  }

  private crossScene(l: SimLink) {
    const s = typeof l.source === 'object' ? (l.source as SimNode).id : String(l.source);
    const t = typeof l.target === 'object' ? (l.target as SimNode).id : String(l.target);
    const a = this.sceneOf(s);
    const b = this.sceneOf(t);
    return a !== undefined && b !== undefined && a !== b;
  }

  private anchorOf(id: string) {
    const sc = this.sceneOf(id);
    return sc === undefined ? undefined : this.anchors.get(sc);
  }

  /** Artists pull toward their scene's island; before scenes exist, everything pulls to the middle. */
  private pullOf(id: string) {
    if (!this.anchors.size) return this.prefs.center;
    return this.anchorOf(id) ? TUNING.scenePull * (this.prefs.center / 0.04) : 0;
  }

  /**
   * Lays out scenes as separate islands, and keeps them where they are as the map grows.
   *
   * Scene ids from community detection change every time it reruns, so each island has its own
   * stable key: a recomputed scene keeps the island (key + position) that most of its members
   * already belonged to. Only genuinely new scenes get a new spot, placed in free space. Existing
   * islands may shift a little to make room, but never jump.
   */
  setScenes(sceneOf: (id: string) => number | undefined) {
    // Members of each (freshly computed) scene, biggest first: big scenes keep their island first.
    const members = new Map<number, SimNode[]>();
    for (const n of this.nodes.values()) {
      const sc = sceneOf(n.id);
      if (sc === undefined) continue;
      if (!members.has(sc)) members.set(sc, []);
      members.get(sc)!.push(n);
    }
    const ordered = [...members].sort((a, b) => b[1].length - a[1].length);

    // Match each scene to the island most of its members were already on.
    const keyOfScene = new Map<number, number>();
    const claimed = new Set<number>();
    for (const [sc, ns] of ordered) {
      const votes = new Map<number, number>();
      for (const n of ns) {
        const k = this.islandOf.get(n.id);
        if (k !== undefined) votes.set(k, (votes.get(k) ?? 0) + 1);
      }
      let best: number | undefined;
      let bestVotes = 0;
      for (const [k, v] of votes) {
        if (!claimed.has(k) && this.anchors.has(k) && v > bestVotes) {
          best = k;
          bestVotes = v;
        }
      }
      const key = best ?? this.nextIsland++;
      claimed.add(key);
      keyOfScene.set(sc, key);
    }

    interface Island extends SimulationNodeDatum {
      key: number;
      r: number;
      /** Where this island already was (undefined = new island) */
      home?: { x: number; y: number };
    }
    const islands: Island[] = [];
    const centroid = new Map<number, { x: number; y: number }>();
    for (const [sc, ns] of ordered) {
      const key = keyOfScene.get(sc)!;
      const cx = ns.reduce((a, n) => a + (n.x ?? 0), 0) / ns.length;
      const cy = ns.reduce((a, n) => a + (n.y ?? 0), 0) / ns.length;
      centroid.set(key, { x: cx, y: cy });
      const dists = ns.map((n) => Math.hypot((n.x ?? 0) - cx, (n.y ?? 0) - cy)).sort((a, b) => a - b);
      // Island size: how big it actually is now, but at least what its member count needs.
      const r = Math.max(30, Math.sqrt(ns.length) * 14, dists[Math.floor(dists.length * 0.8)] ?? 0);
      const home = this.anchors.get(key);
      const fixed = home && this.settledIslands.has(key);
      islands.push({ key, r, home, x: home?.x ?? cx, y: home?.y ?? cy, fx: fixed ? home.x : undefined, fy: fixed ? home.y : undefined });
    }

    // Ties between islands (links between their members).
    const islandOfNode = (id: string) => {
      const sc = sceneOf(id);
      return sc === undefined ? undefined : keyOfScene.get(sc);
    };
    const ties = new Map<string, number>();
    this.graph.forEachEdge((_e, _a, s, t) => {
      const a = islandOfNode(s);
      const b = islandOfNode(t);
      if (a === undefined || b === undefined || a === b) return;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      ties.set(k, (ties.get(k) ?? 0) + 1);
    });
    const tieLinks = [...ties].map(([k, w]) => {
      const [a, b] = k.split('|').map(Number);
      return { source: a, target: b, w };
    });

    // A small separate simulation for the islands (instant, off screen). Existing islands are
    // held near home; new ones find a free spot near the islands they're tied to.
    const gap = TUNING.sceneGap;
    const islandSim = forceSimulation<Island>(islands)
      .stop()
      .force('collide', forceCollide<Island>((i) => i.r + gap / 2).strength(1).iterations(3))
      .force(
        'ties',
        forceLink<Island, SimulationLinkDatum<Island> & { w: number }>(tieLinks)
          .id((i) => i.key)
          .distance((l) => (l.source as Island).r + (l.target as Island).r + gap)
          .strength((l) => Math.min(0.3, 0.02 * l.w)),
      )
      .force('x', forceX<Island>((i) => i.home?.x ?? 0).strength((i) => (i.home ? 0.5 : 0.03)))
      .force('y', forceY<Island>((i) => i.home?.y ?? 0).strength((i) => (i.home ? 0.5 : 0.03)));
    islandSim.tick(200);

    const anchors = new Map(islands.map((i) => [i.key, { x: i.x ?? 0, y: i.y ?? 0 }]));

    // Glides: a new island slides its members from where they are to its spot; an existing island
    // that had to make room slides by however far it moved. Islands that stayed put don't move.
    this.glides.clear();
    for (const isl of islands) {
      const to = anchors.get(isl.key)!;
      const from = isl.home ?? centroid.get(isl.key)!;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      if (Math.hypot(dx, dy) > 20) this.glides.set(isl.key, { dx, dy, frame: 0 });
    }

    // Commit: stable island key per artist.
    this.anchors = anchors;
    this.islandOf = new Map();
    for (const [sc, ns] of members) for (const n of ns) this.islandOf.set(n.id, keyOfScene.get(sc)!);
    this.sceneOf = (id) => this.islandOf.get(id);

    // Re-aim the forces at the anchors and scenes (link lengths depend on scenes too).
    this.applyPrefs(false);
    this.dirty = true;
    if (this.glides.size) {
      this.releasePins();
      this.heat(0.2);
    }
  }

  /** Moves gliding scenes one frame along an ease-in-out path. */
  private stepGlides() {
    if (!this.glides.size) return;
    const total = TUNING.glideFrames;
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    const share = new Map<number, [number, number]>();
    for (const [sc, g] of this.glides) {
      const f = ease((g.frame + 1) / total) - ease(g.frame / total);
      share.set(sc, [g.dx * f, g.dy * f]);
      if (++g.frame >= total) this.glides.delete(sc);
    }
    for (const n of this.nodes.values()) {
      const sc = this.sceneOf(n.id);
      const d = sc === undefined ? undefined : share.get(sc);
      if (!d || n.id === this.dragging) continue;
      n.x = (n.x ?? 0) + d[0];
      n.y = (n.y ?? 0) + d[1];
      if (n.fx != null) n.fx += d[0];
      if (n.fy != null) n.fy += d[1];
    }
  }

  /** Holds these nodes exactly where they are (e.g. a found connection laid out as a chain). */
  hold(ids: string[]) {
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (!n) continue;
      const a = this.graph.getNodeAttributes(id) as { x: number; y: number };
      n.x = n.fx = a.x;
      n.y = n.fy = a.y;
      n.vx = n.vy = 0;
      this.held.add(n);
    }
  }

  /** Lets held nodes move again. */
  releaseHeld() {
    for (const n of this.held) {
      if (n.id === this.dragging) continue;
      n.fx = null;
      n.fy = null;
    }
    this.held.clear();
  }

  /**
   * Call when automatic growth has finished and the map has settled: from now on the islands you
   * are looking at stay exactly where they are; later additions only place new scenes.
   */
  lockIslands() {
    for (const k of this.anchors.keys()) this.settledIslands.add(k);
  }

  rerun() {
    this.releasePins();
    this.heat(HEAT.rerun);
  }

  /** Dragging: the node follows the pointer and the rest of the graph reacts live. */
  dragStart(id: string) {
    this.releasePins(); // the neighbors should react to your drag
    this.dragging = id;
    const n = this.nodes.get(id);
    if (n) {
      n.fx = n.x;
      n.fy = n.y;
    }
    this.sim.alphaTarget(HEAT.drag);
    this.start();
  }

  dragMove(id: string, x: number, y: number) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.fx = x;
    n.fy = y;
  }

  dragEnd(id: string) {
    const n = this.nodes.get(id);
    if (n) {
      n.fx = null;
      n.fy = null;
    }
    this.dragging = null;
    this.sim.alphaTarget(0); // let it cool down and stop
  }

  private heat(alpha: number) {
    if (this.prefs.paused) return;
    this.sim.alpha(Math.max(this.sim.alpha(), alpha));
    this.start();
  }

  start() {
    if (this.prefs.paused) return;
    if (!this.frame) this.frame = requestAnimationFrame(this.step);
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private step = () => {
    this.frame = 0;
    if (this.prefs.paused) return;

    if (this.dirty) {
      // Re-attach arrays only when something changed (d3 re-initializes forces on this).
      this.sim.nodes([...this.nodes.values()]);
      (this.sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>>).links([...this.links.values()]);
      this.dirty = false;
    }

    this.stepGlides();
    // One tick per frame keeps motion even; big graphs just take a little longer to settle.
    this.sim.tick();
    if (this.arrivalPins.size && this.sim.alpha() < TUNING.releaseAlpha) {
      this.releasePins();
      // Newcomers already found their place while everything else was held; what's left is just
      // a tiny relaxation, not a re-layout.
      for (const n of this.nodes.values()) {
        n.vx = 0;
        n.vy = 0;
      }
      // After a fresh search the map gets one real settle (readability); after additions to a
      // map at rest, only a nudge (stability).
      const after = this.calmRelease ? TUNING.calmAfterReleaseAlpha : TUNING.afterReleaseAlpha;
      this.sim.alpha(Math.min(this.sim.alpha(), after));
      this.calmRelease = false;
    }

    const dragging = this.dragging;
    const nodes = this.nodes;
    this.graph.updateEachNodeAttributes(
      (id, attrs) => {
        const n = nodes.get(id);
        if (!n || id === dragging || !Number.isFinite(n.x) || !Number.isFinite(n.y)) return attrs;
        attrs.x = n.x;
        attrs.y = n.y;
        return attrs;
      },
      { attributes: ['x', 'y'] },
    );

    if (this.sim.alpha() > this.sim.alphaMin() || this.dragging || this.glides.size) {
      this.frame = requestAnimationFrame(this.step);
    } else {
      const fns = this.restListeners;
      this.restListeners = [];
      for (const fn of fns) fn();
    }
  };
}
