import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildExport } from '../server/export.ts';
import type { MbArtist, MbReleaseGroup } from '../server/mb.ts';
import { applySave, frontier } from '../server/store.ts';
import { buildSuggestions, isStudioAlbum, relationToEdge } from '../server/suggest.ts';
import type { GraphData, Suggestion } from '../src/shared/types.ts';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8')) as T;

const softMachine = fixture<MbArtist>('soft-machine.artist.json');
const softMachineAlbums = fixture<MbReleaseGroup[]>('soft-machine.release-groups.json');
const wyatt = fixture<MbArtist>('robert-wyatt.artist.json');

const SM = softMachine.id;
const WYATT = wyatt.id;
const empty = (): GraphData => ({ artists: {}, albums: {}, edges: [], rejected: [] });
const edgeSugs = (s: Suggestion[]) => s.filter((x): x is Extract<Suggestion, { kind: 'edge' }> => x.kind === 'edge');

describe('buildSuggestions (Soft Machine)', () => {
  const res = buildSuggestions(softMachine, softMachineAlbums, empty());
  const edges = edgeSugs(res.suggestions);

  it('maps band members as person → band', () => {
    const members = edges.filter((s) => s.edge.type === 'member_of');
    const names = members.map((s) => s.other.name);
    expect(names).toEqual(expect.arrayContaining(['Robert Wyatt', 'Kevin Ayers', 'Hugh Hopper', 'Mike Ratledge', 'Daevid Allen']));
    for (const s of members) {
      expect(s.edge.target).toBe(SM);
      expect(s.edge.source).toBe(s.other.id);
      expect(s.other.kind).toBe('person');
    }
  });

  it('folds repeated stints into one edge per person', () => {
    const ids = edges.map((s) => s.edge.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps instruments for supporting musicians', () => {
    const percy = edges.find((s) => s.other.name === 'Percy Jones');
    expect(percy?.edge.type).toBe('supporting');
    expect(percy?.edge.attributes).toContain('bass');
    expect(percy?.edge.source).toBe(percy?.other.id);
  });

  it('skips tribute / named-after relations', () => {
    const types = new Set(edges.map((s) => s.edge.type));
    expect([...types].every((t) => ['member_of', 'supporting', 'collaborated', 'founded', 'subgroup_of'].includes(t))).toBe(true);
  });

  it('suggests only studio albums, oldest first', () => {
    const albums = res.suggestions.filter((s) => s.kind === 'album');
    const titles = albums.map((s) => (s.kind === 'album' ? s.album.title : ''));
    expect(titles).toEqual(expect.arrayContaining(['The Soft Machine', 'Third']));
    expect(titles).not.toContain('Fourth / Fifth'); // compilation
    expect(softMachineAlbums.filter(isStudioAlbum).length).toBe(albums.length);
    const years = albums.map((s) => (s.kind === 'album' ? s.album.year ?? '9999' : ''));
    expect([...years].sort()).toEqual(years);
  });

  it('reads the Wikidata id', () => {
    expect(res.focus.wikidata).toMatch(/^Q\d+$/);
  });
});

describe('direction from the person side (Robert Wyatt)', () => {
  it('produces the same edge id as from the band side', () => {
    const fromWyatt = edgeSugs(buildSuggestions(wyatt, [], empty()).suggestions);
    const smEdge = fromWyatt.find((s) => s.other.id === SM);
    expect(smEdge?.edge.id).toBe(`member_of:${WYATT}:${SM}`);
    // Personal relations (married, sibling) are skipped.
    expect(fromWyatt.every((s) => s.edge.type === 'member_of')).toBe(true);
  });

  it('relationToEdge ignores unknown types', () => {
    expect(relationToEdge(WYATT, { type: 'married', 'target-type': 'artist', direction: 'forward', artist: { id: 'x', name: 'x', 'sort-name': 'x' } })).toBeNull();
  });
});

describe('review flow', () => {
  it('accepts, rejects, hides both next time, and dedupes artists', () => {
    const graph = empty();
    const first = buildSuggestions(softMachine, softMachineAlbums, graph);
    const edges = edgeSugs(first.suggestions);
    const [rejectMe, ...keep] = edges;
    const album = first.suggestions.find((s) => s.kind === 'album')!;

    applySave(graph, { focus: first.focus, accept: [...keep, album], reject: [rejectMe.edge.id] });

    expect(graph.artists[SM].expandedAt).toBeTruthy();
    expect(graph.edges).toHaveLength(keep.length + 1);
    expect(graph.rejected).toEqual([rejectMe.edge.id]);

    const again = buildSuggestions(softMachine, softMachineAlbums, graph);
    expect(edgeSugs(again.suggestions)).toHaveLength(0);
    expect(again.hidden).toEqual({ accepted: keep.length + 1, rejected: 1 });

    // Expanding Wyatt from the other side doesn't duplicate the shared edge or artist.
    const fromWyatt = buildSuggestions(wyatt, [], graph);
    applySave(graph, { focus: fromWyatt.focus, accept: fromWyatt.suggestions, reject: [] });
    expect(graph.edges.filter((e) => e.id === `member_of:${WYATT}:${SM}`)).toHaveLength(1);
    expect(Object.values(graph.artists).filter((a) => a.name === 'Robert Wyatt')).toHaveLength(1);
    expect(graph.artists[WYATT].country).toBe('GB'); // filled in from the full lookup

    const next = frontier(graph);
    expect(next.find((a) => a.id === SM || a.id === WYATT)).toBeUndefined();
    expect(next.length).toBeGreaterThan(0);
  });
});

describe('buildExport', () => {
  it('lays out every node deterministically', () => {
    const graph = empty();
    const s = buildSuggestions(softMachine, softMachineAlbums, graph);
    applySave(graph, { focus: s.focus, accept: s.suggestions, reject: [] });
    const a = buildExport(graph, new Date(0));
    const b = buildExport(graph, new Date(0));
    expect(a).toEqual(b);
    expect(a.nodes.length).toBe(Object.keys(graph.artists).length + Object.keys(graph.albums).length);
    expect(a.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    // The band is the hub, so it should be the biggest node.
    const biggest = [...a.nodes].sort((x, y) => y.size - x.size)[0];
    expect(biggest.id).toBe(SM);
  });
});
