import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = JSON.parse(
  await fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8')
);

const failures = [];
const fail = (message) => failures.push(message);

if (runtime.projection?.type !== 'globe') fail('The reusable style must use globe projection.');
if (runtime.fog) fail('Mapbox fog must be translated instead of shipped to MapLibre unchanged.');
if (!runtime.sky) fail('The MapLibre sky/atmosphere configuration is missing.');
if (!runtime.sky?.['sky-color']) fail('The dark outer-space color is missing.');
if (!runtime.sky?.['horizon-color']) fail('The atmospheric horizon color is missing.');
if (!runtime.sky?.['atmosphere-blend']) fail('The globe atmosphere blend is missing.');

const relief = runtime.layers.find((layer) => layer.id === 'occumed-shaded-relief');
if (!relief) fail('The low-zoom relief layer is missing.');
if ((relief?.paint?.['raster-saturation'] ?? 0) < 0.3) {
  fail('Low-zoom relief is not saturated enough for the exported green/blue globe target.');
}

const hillshade = runtime.layers.find((layer) => layer.id === 'occumed-hillshade');
if (!hillshade) fail('The open hillshade layer is missing.');
if (hillshade?.paint?.['hillshade-illumination-anchor'] !== 'map') {
  fail('Hillshade must remain geographically anchored while the globe rotates.');
}

const background = runtime.layers.find((layer) => layer.id === 'land');
if (background?.paint?.['background-color'] !== 'hsl(60, 20%, 85%)') {
  fail('The exported Occu-Med land background color changed.');
}

if (failures.length) {
  console.error('Occu-Med globe parity validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Globe parity validated: dark space, atmosphere, vivid low-zoom relief, and anchored hillshade.');
