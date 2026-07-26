import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = JSON.parse(
  await fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8')
);

const failures = [];
const fail = (message) => failures.push(message);

function collectHex(value, colors = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) collectHex(child, colors);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectHex(child, colors);
  } else if (typeof value === 'string' && /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/.test(value)) {
    colors.add(value);
  }
  return colors;
}

if (runtime.projection?.type !== 'globe') fail('The reusable style must use globe projection.');
if (runtime.fog) fail('Mapbox fog must be translated instead of shipped to MapLibre unchanged.');
if (!runtime.sky) fail('The MapLibre sky/atmosphere configuration is missing.');
if (runtime.sky?.['sky-color'] !== '#03070B') fail('The fixed dark-space hex changed.');
if (runtime.sky?.['horizon-color'] !== '#F5FDFFFF') fail('The atmospheric horizon hex changed.');
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
if (relief?.paint?.['raster-saturation'] !== -1) {
  fail('Hypsometric color remains active instead of neutral relief texture.');
}
if ((relief?.paint?.['raster-contrast'] ?? 1) > 0.05) {
  fail('Neutral relief contrast is too aggressive for the exported palette.');
}
if ((relief?.maxzoom ?? 99) > 8) {
  fail('Raster relief persists too far into regional zooms.');
}

const hillshade = runtime.layers.find((layer) => layer.id === 'occumed-hillshade');
if (!hillshade) fail('The open hillshade layer is missing.');
if (hillshade?.paint?.['hillshade-illumination-anchor'] !== 'map') {
  fail('Hillshade must remain geographically anchored while the globe rotates.');
}
if (hillshade?.paint?.['hillshade-shadow-color'] !== '#52685B') {
  fail('The neutral hillshade-shadow hex changed.');
}

const allColors = collectHex(runtime.layers.map((layer) => layer.paint || {}));
if (allColors.size < 25) {
  fail(`The exported globe palette was flattened to only ${allColors.size} colors.`);
}

if (!runtime.metadata?.['occumed:exported-cartography-restored']) {
  fail('The final exported-cartography restoration pass did not run.');
}
if (runtime.metadata?.['occumed:reference-color-system'] !== 'exported-per-layer-hex-v6') {
  fail('The final exported per-layer hex pass did not run.');
}
if (runtime.metadata?.['occumed:palette-format'] !== 'fixed-hex-per-layer') {
  fail('The per-layer fixed-hex palette marker is missing.');
}
if (runtime.metadata?.['occumed:layer-specific-palette'] !== true) {
  fail('Layer-specific palette protection is missing.');
}

if (failures.length) {
  console.error('Occu-Med globe parity validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Globe parity validated: dark space, luminous rim, ${allColors.size} structure-specific colors, neutral relief, and anchored hillshade.`);
