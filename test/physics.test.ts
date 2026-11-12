import Graph from 'graphology';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '../src/site/layout-controls.ts';
import { Physics } from '../src/site/physics.ts';

// Drive the animation loop synchronously in tests.
function withFakeFrames() {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (queue.push(cb), queue.length));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return {
    /** Runs frames until the loop stops (or the cap is hit); returns how many ran. */
    run(cap = 5000) {
      let n = 0;
      while (queue.length && n < cap) {
        queue.shift()!(0);
        n++;
      }
      return n;
    },
  };
}

/** Bands with members, some members shared between bands: a small "scene". */
function scene(bands = 60, membersPerBand = 18) {
  const g = new Graph({ type: 'undirected', multi: true });
  let r = 1;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let b = 0; b < bands; b++) {
    g.addNode(`b${b}`, { x: rand() * 100, y: rand() * 100, size: 6 });
    for (let m = 0; m < membersPerBand; m++) {
      const id = rand() < 0.15 && b > 0 ? `p${Math.floor(rand() * b * membersPerBand)}` : `p${b * membersPerBand + m}`;
      if (!g.hasNode(id)) g.addNode(id, { x: rand() * 100, y: rand() * 100, size: 4 });
      if (!g.hasEdge(id, `b${b}`)) g.addEdge(id, `b${b}`);
    }
  }
  return g;
}

describe('Physics', () => {
  it('settles and stops on its own, then stays perfectly still', () => {
    const frames = withFakeFrames();
    const g = scene();
    const physics = new Physics(g, { ...DEFAULT_PREFS });
    physics.sync();
    const ran = frames.run();
    expect(ran).toBeLessThan(5000); // it stopped by itself
    expect(physics.isRunning()).toBe(false);
    g.forEachNode((_n, a) => expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true));

    // At rest: no more frames, positions unchanged.
    const before = g.mapNodes((_n, a) => [a.x, a.y]);
    expect(frames.run()).toBe(0);
    expect(g.mapNodes((_n, a) => [a.x, a.y])).toEqual(before);
  });

  it('wakes for new nodes and for slider changes, then stops again', () => {
    const frames = withFakeFrames();
    const g = scene(10, 8);
    const prefs = { ...DEFAULT_PREFS };
    const physics = new Physics(g, prefs);
    physics.sync();
    frames.run();

    g.addNode('new', { x: 0, y: 0, size: 4 });
    g.addEdge('new', 'b0');
    physics.sync();
    expect(frames.run()).toBeGreaterThan(0);
    expect(physics.isRunning()).toBe(false);

    prefs.repel = 600;
    physics.applyPrefs(true);
    expect(frames.run()).toBeGreaterThan(0);
    expect(physics.isRunning()).toBe(false);
  });

  it('keeps the existing layout steady when new artists arrive', () => {
    const frames = withFakeFrames();
    const g = scene(40, 12);
    const physics = new Physics(g, { ...DEFAULT_PREFS });
    physics.sync();
    frames.run();
    const before = new Map(g.mapNodes((n, a) => [n, [a.x as number, a.y as number]] as const));

    // A band with 30 new members arrives next to an existing one, like a lookup during growth.
    const anchor = g.getNodeAttributes('b3') as { x: number; y: number };
    for (let i = 0; i < 30; i++) {
      g.addNode(`n${i}`, { x: anchor.x + 45 * Math.cos(i), y: anchor.y + 45 * Math.sin(i), size: 4 });
      g.addEdge(`n${i}`, 'b3');
    }
    physics.sync();
    frames.run();
    expect(physics.isRunning()).toBe(false);

    // Old nodes only get the gentle final settle: on average they move a few px, never far.
    let total = 0;
    let max = 0;
    for (const [n, [x0, y0]] of before) {
      const a = g.getNodeAttributes(n) as { x: number; y: number };
      const d = Math.hypot(a.x - x0, a.y - y0);
      total += d;
      max = Math.max(max, d);
    }
    const mean = total / before.size;
    expect(mean).toBeLessThan(8);
    expect(max).toBeLessThan(60);
  });

  it('never moves a node faster than the speed limit', () => {
    const frames = withFakeFrames();
    const g = scene(20, 10);
    // Everyone starts on top of each other: the worst case for explosions.
    g.forEachNode((n) => g.mergeNodeAttributes(n, { x: 0.01 * Math.random(), y: 0.01 * Math.random() }));
    const physics = new Physics(g, { ...DEFAULT_PREFS });
    physics.sync();
    let prev = new Map(g.mapNodes((n, a) => [n, [a.x as number, a.y as number]] as const));
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      if (!frames.run(1)) break;
      for (const [n, [x0, y0]] of prev) {
        const a = g.getNodeAttributes(n) as { x: number; y: number };
        worst = Math.max(worst, Math.hypot(a.x - x0, a.y - y0));
      }
      prev = new Map(g.mapNodes((n, a) => [n, [a.x as number, a.y as number]] as const));
    }
    expect(worst).toBeLessThanOrEqual(10 + 1e-6);
  });

  it('islands stay put when scenes are recalculated (e.g. after clicking a ring)', () => {
    const frames = withFakeFrames();
    // Three separate "scenes": bands b0–b2, b3–b5, b6–b8 with their members.
    const g = scene(9, 6);
    const physics = new Physics(g, { ...DEFAULT_PREFS });
    physics.sync();
    const sceneOfBand = (b: number) => Math.floor(b / 3);
    const sceneOf = (labels: number[]) => (id: string) => {
      // members follow their first band; relabeling simulates community detection rerunning
      const band = id.startsWith('b') ? Number(id.slice(1)) : Number(g.neighbors(id).find((n) => n.startsWith('b'))?.slice(1) ?? 0);
      return labels[sceneOfBand(band)];
    };
    physics.setScenes(sceneOf([0, 1, 2]));
    frames.run();
    physics.lockIslands(); // automatic growth finished
    const before = new Map(g.mapNodes((n, a) => [n, [a.x as number, a.y as number]] as const));

    // Click a ring: a few new artists arrive, and the scene ids come back shuffled.
    for (let i = 0; i < 4; i++) {
      g.addNode(`x${i}`, { x: 0, y: 0, size: 4 });
      g.addEdge(`x${i}`, 'b4');
    }
    physics.sync();
    physics.setScenes(sceneOf([2, 0, 1]));
    frames.run();

    let total = 0;
    for (const [n, [x0, y0]] of before) {
      const a = g.getNodeAttributes(n) as { x: number; y: number };
      total += Math.hypot(a.x - x0, a.y - y0);
    }
    expect(total / before.size).toBeLessThan(12);
  });

  it('a dragged node stays where it is put while the rest reacts', () => {
    const frames = withFakeFrames();
    const g = scene(5, 6);
    const physics = new Physics(g, { ...DEFAULT_PREFS });
    physics.sync();
    frames.run();

    physics.dragStart('b0');
    g.mergeNodeAttributes('b0', { x: 500, y: 500 }); // sigma moves the node under the pointer
    physics.dragMove('b0', 500, 500);
    frames.run(60); // keeps running while held
    expect(physics.isRunning()).toBe(true);
    expect(g.getNodeAttribute('b0', 'x')).toBe(500);
    physics.dragEnd('b0');
    frames.run();
    expect(physics.isRunning()).toBe(false);
  });
});
