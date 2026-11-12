// npm run export → public/graph.export.json (positions precomputed for the public site)
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildExport } from '../server/export.ts';
import { loadGraph } from '../server/store.ts';

const out = resolve(import.meta.dirname, '../public/graph.export.json');
const data = buildExport(await loadGraph());
await mkdir(resolve(out, '..'), { recursive: true });
await writeFile(out, JSON.stringify(data));
console.log(`Exported ${data.nodes.length} nodes, ${data.edges.length} edges → public/graph.export.json`);
