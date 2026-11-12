// Dev-only HTTP API used by the review page. Mounted by the Vite plugin in vite.config.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SaveRequest, SearchHit } from '../src/shared/types.ts';
import { buildExport } from './export.ts';
import { artistAlbums, lookupArtist, searchArtists } from './mb.ts';
import { applySave, frontier, loadGraph, saveGraph } from './store.ts';
import { buildSuggestions, mbKind } from './suggest.ts';

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Next = (err?: unknown) => void;

// Saves are serialized so two quick clicks can't clobber each other.
let writeLock: Promise<unknown> = Promise.resolve();

export async function handleApi(req: IncomingMessage, res: ServerResponse, next: Next) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/api/search') {
      const q = url.searchParams.get('q')?.trim();
      if (!q) return send(res, 400, { error: 'Missing q' });
      const [hits, graph] = await Promise.all([searchArtists(q), loadGraph()]);
      const out: SearchHit[] = hits.map((h) => ({
        id: h.id,
        name: h.name,
        sortName: h['sort-name'],
        kind: mbKind(h.type),
        disambiguation: h.disambiguation || undefined,
        country: h.country || undefined,
        begin: h['life-span']?.begin || undefined,
        end: h['life-span']?.end || undefined,
        score: h.score,
        inGraph: !!graph.artists[h.id],
      }));
      return send(res, 200, out);
    }

    const suggestMatch = path.match(/^\/api\/suggest\/([^/]+)$/);
    if (req.method === 'GET' && suggestMatch) {
      const mbid = suggestMatch[1];
      if (!MBID.test(mbid)) return send(res, 400, { error: 'Bad MusicBrainz ID' });
      const fresh = url.searchParams.get('fresh') === '1';
      const artist = await lookupArtist(mbid, fresh);
      const albums = await artistAlbums(mbid, fresh);
      return send(res, 200, buildSuggestions(artist, albums, await loadGraph()));
    }

    if (req.method === 'POST' && path === '/api/save') {
      const body = (await readJson(req)) as SaveRequest;
      if (!body?.focus?.id || !MBID.test(body.focus.id)) return send(res, 400, { error: 'Bad focus artist' });
      const result = (writeLock = writeLock.then(async () => {
        const graph = applySave(await loadGraph(), body);
        await saveGraph(graph);
        return { artists: Object.keys(graph.artists).length, edges: graph.edges.length };
      }));
      return send(res, 200, await result);
    }

    if (req.method === 'GET' && path === '/api/frontier') {
      return send(res, 200, frontier(await loadGraph()).slice(0, 200));
    }

    if (req.method === 'GET' && path === '/api/stats') {
      const g = await loadGraph();
      return send(res, 200, {
        artists: Object.keys(g.artists).length,
        albums: Object.keys(g.albums).length,
        edges: g.edges.length,
        rejected: g.rejected.length,
      });
    }

    return next();
  } catch (err) {
    console.error('[api]', err);
    return send(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Serves a live export in dev so the explorer always reflects data/graph.json. */
export async function handleExport(_req: IncomingMessage, res: ServerResponse) {
  send(res, 200, buildExport(await loadGraph()));
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
