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
if (runtime.light) fail('Directional global light must remain disabled to prevent rotation-dependent washout.');
if (runtime.sky?.['horizon-fog-blend'] !== 0) {
  fail('Horizon fog must remain disabled to prevent the globe surface from washing out.');
}
if (runtime.sky?.['fog-ground-blend'] !== 0) {
  fail('Ground fog must remain disabled to preserve surface contrast.');
}

const atmosphereBlend = runtime.sky?.['atmosphere-blend'];
if (Array.isArray(atmosphereBlend)) {
  const outputs = [];
  for (let index = 4; index < atmosphereBlend.length; index += 2) {
    if (typeof atmosphereBlend[index] === 'number') outputs.push(atmosphereBlend[index]);
  }
  if (outputs.some((value) => value > 0.2)) {
    fail('Atmosphere opacity is high enough to overexpose the globe.');
  }
}

const relief = runtime.layers.find((layer) => layer.id === 'occumed-shaded-relief');
if (!relief) fail('The low-zoom relief layer is missing.');
if ((relief?.paint?.['raster-saturation'] ?? 0) < 0.9) {
  fail('Low-zoom relief is not saturated enough for the supplied green/blue globe reference.');
}
if ((relief?.paint?.['raster-contrast'] ?? 0) < 0.18) {
  fail('Low-zoom relief is too flat for the supplied reference.');
}

const hillshade = runtime.layers.find((layer) => layer.id === 'occumed-hillshade');
if (!hillshade) fail('The open hillshade layer is missing.');
if (hillshade?.paint?.['hillshade-illumination-anchor'] !== 'map') {
  fail('Hillshade must remain geographically anchored while the globe rotates.');
}

const background = runtime.layers.find((layer) => layer.id === 'land');
if (background?.paint?.['background-color'] !== 'hsl(68, 28%, 83%)') {
  fail('The corrected warm green land background changed.');
}

const water = runtime.layers.find((layer) => layer.id === 'water');
if (water?.paint?.['fill-color'] !== 'hsl(205, 76%, 66%)') {
  fail('The corrected richer ocean color changed.');
}

if (!runtime.metadata?.['occumed:exported-cartography-restored']) {
  fail('The final exported-cartography restoration pass did not run.');
}
if (runtime.metadata?.['occumed:reference-color-system'] !== 'mapbox-photo-reference-v4') {
  fail('The final reference color pass did not run.');
}

if (failures.length) {
  console.error('Occu-Med globe parity validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Globe parity validated: stable dark space, visible rim, corrected land and ocean colors, vivid relief, and anchored hillshade.');
