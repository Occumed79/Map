import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = JSON.parse(
  await fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8')
);

const failures = [];
const fail = (message) => failures.push(message);
const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);

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
if (runtime.sky?.['horizon-color'] !== '#F5FDFF') fail('The atmospheric horizon hex changed.');
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

const relief = layer('occumed-shaded-relief');
if (!relief) fail('The low-zoom relief layer is missing.');
const reliefSaturation = relief?.paint?.['raster-saturation'];
if (typeof reliefSaturation !== 'number' || reliefSaturation < 0 || reliefSaturation > 0.25) {
  fail('Physical relief must retain restrained color without becoming fluorescent or monochrome.');
}
const reliefContrast = relief?.paint?.['raster-contrast'];
if (typeof reliefContrast !== 'number' || reliefContrast < 0.07 || reliefContrast > 0.11) {
  fail('Physical relief contrast is outside the approved visible-but-restrained range.');
}
if ((relief?.maxzoom ?? 99) > 8.5) {
  fail('Raster relief persists too far into city zooms.');
}
const reliefOpacity = JSON.stringify(relief?.paint?.['raster-opacity'] || []);
if (!reliefOpacity.includes('0.32')) {
  fail('The globe has lost the visible physical-relief contribution.');
}
if (reliefOpacity.includes('0.72') || reliefOpacity.includes('0.64')) {
  fail('The fluorescent high-opacity relief blend returned.');
}

const landcover = layer('landcover');
if ((landcover?.minzoom ?? 99) !== 0) fail('Landcover is unavailable at globe zoom.');
const landcoverOpacity = JSON.stringify(landcover?.paint?.['fill-opacity'] || []);
if (!landcoverOpacity.includes('0.82') || !landcoverOpacity.includes('0.86')) {
  fail('The globe and regional landcover colors are being hidden by the background land layer.');
}

const water = layer('water');
if (water?.paint?.['fill-opacity'] !== 1) {
  fail('Water is blending into the land background instead of remaining a strong blue field.');
}

const hillshade = layer('occumed-hillshade');
if (!hillshade) fail('The open hillshade layer is missing.');
if (hillshade?.minzoom !== 1.5) fail('Hillshade begins too late to shape the globe.');
if (hillshade?.paint?.['hillshade-illumination-anchor'] !== 'map') {
  fail('Hillshade must remain geographically anchored while the globe rotates.');
}
if (hillshade?.paint?.['hillshade-shadow-color'] !== '#52685B') {
  fail('The terrain hillshade-shadow hex changed.');
}

if ((layer('road-motorway-trunk')?.minzoom ?? 99) > 2) {
  fail('Major highways enter too late for the supplied regional hierarchy.');
}
if ((layer('admin-0-boundary')?.minzoom ?? 99) > 0) {
  fail('Country boundaries are unavailable at globe zoom.');
}

const allColors = collectHex(runtime.layers.map((candidate) => candidate.paint || {}));
if (allColors.size < 25) {
  fail(`The exported globe palette was flattened to only ${allColors.size} colors.`);
}

if (!runtime.metadata?.['occumed:exported-cartography-restored']) {
  fail('The final exported-cartography restoration pass did not run.');
}
if (runtime.metadata?.['occumed:reference-color-system'] !== 'exported-per-layer-visible-v7') {
  fail('The final visible per-layer hex pass did not run.');
}
if (runtime.metadata?.['occumed:palette-format'] !== 'fixed-hex-per-layer') {
  fail('The per-layer fixed-hex palette marker is missing.');
}
if (runtime.metadata?.['occumed:layer-specific-palette'] !== true) {
  fail('Layer-specific palette protection is missing.');
}
if (runtime.metadata?.['occumed:visible-low-zoom-cartography'] !== true) {
  fail('Low-zoom cartographic visibility protection is missing.');
}

if (failures.length) {
  console.error('Occu-Med globe parity validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Globe parity validated: dark space, luminous rim, visible colored terrain, opaque water, early hierarchy, and ${allColors.size} structure-specific colors.`);
