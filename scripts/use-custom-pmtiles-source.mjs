import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const archiveUrl = process.env.OCCUMED_PMTILES_URL?.trim();
const source = runtime.sources?.['occumed-open'];

if (!source || source.type !== 'vector') {
  throw new Error('The runtime style is missing the shared Occu-Med vector source.');
}

if (archiveUrl) {
  const normalized = archiveUrl.startsWith('pmtiles://') ? archiveUrl : `pmtiles://${archiveUrl}`;
  source.url = normalized.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', '__OCCUMED_PUBLIC_ORIGIN__');
  delete source.tiles;
  source.attribution =
    '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';

  runtime.metadata = {
    ...(runtime.metadata || {}),
    'occumed:vector-source-mode': 'custom-planetiler-pmtiles',
    'occumed:custom-pmtiles-enabled': true
  };
} else {
  runtime.metadata = {
    ...(runtime.metadata || {}),
    'occumed:vector-source-mode': 'open-source-fallback',
    'occumed:custom-pmtiles-enabled': false
  };
}

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(
  archiveUrl
    ? `Configured custom PMTiles source: ${archiveUrl}`
    : 'OCCUMED_PMTILES_URL is not set; retained the existing open vector fallback.'
);
