import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const archiveUrl = process.env.OCCUMED_PMTILES_URL?.trim();
const configuredWorldManifest = process.env.OCCUMED_WORLD_MANIFEST_URL?.trim();
const worldManifestUrl = configuredWorldManifest === 'off'
  ? null
  : configuredWorldManifest || '__OCCUMED_PUBLIC_ORIGIN__/world-manifest.json';
const idleVectorUrl = '__OCCUMED_PUBLIC_ORIGIN__/empty-vector.json';
const source = runtime.sources?.['occumed-open'];

if (!source || source.type !== 'vector') {
  throw new Error('The runtime style is missing the shared Occu-Med vector source.');
}

function useLocalIdleVectorSource() {
  source.url = idleVectorUrl;
  delete source.tiles;
  source.attribution =
    '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';
}

if (worldManifestUrl) {
  useLocalIdleVectorSource();
  runtime.metadata = {
    ...(runtime.metadata || {}),
    'occumed:vector-source-mode': 'world-sharded-planetiler-pmtiles',
    'occumed:custom-pmtiles-enabled': true,
    'occumed:world-pmtiles-enabled': true,
    'occumed:world-manifest-url': worldManifestUrl,
    'occumed:world-switch-zoom': 6,
    'occumed:low-zoom-vector-mode': 'local-empty-placeholder',
    'occumed:external-vector-fallback-enabled': false
  };
} else if (archiveUrl) {
  const normalized = archiveUrl.startsWith('pmtiles://') ? archiveUrl : `pmtiles://${archiveUrl}`;
  source.url = normalized.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', '__OCCUMED_PUBLIC_ORIGIN__');
  delete source.tiles;
  source.attribution =
    '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';

  runtime.metadata = {
    ...(runtime.metadata || {}),
    'occumed:vector-source-mode': 'custom-planetiler-pmtiles',
    'occumed:custom-pmtiles-enabled': true,
    'occumed:world-pmtiles-enabled': false,
    'occumed:external-vector-fallback-enabled': false
  };
} else {
  useLocalIdleVectorSource();
  runtime.metadata = {
    ...(runtime.metadata || {}),
    'occumed:vector-source-mode': 'no-external-vector-fallback',
    'occumed:custom-pmtiles-enabled': false,
    'occumed:world-pmtiles-enabled': false,
    'occumed:low-zoom-vector-mode': 'local-empty-placeholder',
    'occumed:external-vector-fallback-enabled': false
  };
}

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(
  worldManifestUrl
    ? `Configured worldwide PMTiles manifest without an external vector fallback: ${worldManifestUrl}`
    : archiveUrl
      ? `Configured custom PMTiles source without an external vector fallback: ${archiveUrl}`
      : 'Custom PMTiles is disabled; using the local empty vector placeholder instead of an external fallback.'
);
