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

function expressionOutputs(expression) {
  const outputs = [];
  if (!Array.isArray(expression)) return outputs;
  for (let index = 4; index < expression.length; index += 2) {
    if (typeof expression[index] === 'number') outputs.push(expression[index]);
  }
  return outputs;
}

if (runtime.projection?.type !== 'globe') fail('The reusable style must use globe projection.');
if (runtime.fog) fail('Mapbox fog must be translated instead of shipped to MapLibre unchanged.');
if (!runtime.sky) fail('The MapLibre sky/atmosphere configuration is missing.');
if (runtime.sky?.['sky-color'] !== '#181A1D') fail('The fixed reference-space hex changed.');
if (runtime.sky?.['horizon-color'] !== '#F5FDFF') fail('The atmospheric horizon hex changed.');
if (runtime.sky?.['fog-color'] !== '#B8E6FF') fail('The cool outer-atmosphere hex changed.');
if (!runtime.sky?.['atmosphere-blend']) fail('The globe atmosphere blend is missing.');
if (runtime.light) fail('Directional global light must remain disabled to prevent rotation-dependent washout.');
if (runtime.sky?.['horizon-fog-blend'] !== 0) fail('Horizon fog must remain disabled to prevent surface washout.');
if (runtime.sky?.['fog-ground-blend'] !== 0) fail('Ground fog must remain disabled to preserve surface contrast.');

const atmosphereOutputs = expressionOutputs(runtime.sky?.['atmosphere-blend']);
if (!atmosphereOutputs.some((value) => value >= 0.65)) {
  fail('The white-blue atmosphere is too weak to match the supplied glowing globe reference.');
}
if (atmosphereOutputs.at(-1) !== 0) {
  fail('The globe atmosphere does not disappear before detailed regional and city zooms.');
}

const horizonOutputs = expressionOutputs(runtime.sky?.['sky-horizon-blend']);
if (!horizonOutputs.some((value) => value >= 0.2)) {
  fail('The narrow luminous horizon rim is too weak.');
}
if (horizonOutputs.at(-1) !== 0) {
  fail('The horizon rim does not fade out before detailed zooms.');
}

if (runtime.layers.some((candidate) => candidate.type === 'raster')) {
  fail('A raster fallback basemap was reintroduced.');
}
if (layer('land')?.paint?.['background-color'] !== '#79BCEC') fail('The supplied Studio ocean blue changed.');
if (layer('occumed-land-surface')?.paint?.['fill-color'] !== '#E0E0D1') fail('The supplied Studio land base changed.');

const landcover = layer('landcover');
if ((landcover?.minzoom ?? 99) !== 0) fail('Landcover is unavailable at globe zoom.');
if (!JSON.stringify(landcover?.paint?.['fill-opacity'] || []).includes('1')) {
  fail('Exported landcover swatches are being weakened at globe and regional zooms.');
}

const water = layer('water');
if (water?.paint?.['fill-color'] !== '#79BCEC') fail('The exact exported water blue changed.');
if (water?.paint?.['fill-opacity'] !== 1) fail('Water is blending into the land background.');

const waterDepth = layer('water-depth');
if (waterDepth?.['source-layer'] !== 'depth') fail('The continuous vector bathymetry layer is missing.');
if (waterDepth?.maxzoom !== 8) fail('Bathymetry does not fade before detailed navigation zooms.');
const waterDepthColors = JSON.stringify(waterDepth?.paint?.['fill-color'] || []);
for (const value of ['#79BCEC59', '#5AACE759', '#3B9DE359']) {
  if (!waterDepthColors.includes(value)) fail(`The exported bathymetry swatch ${value} is missing.`);
}

const hillshade = layer('occumed-hillshade');
if (!hillshade) fail('The open hillshade layer is missing.');
if (hillshade?.minzoom !== 1.5) fail('Hillshade begins too late to shape the globe.');
if (hillshade?.paint?.['hillshade-illumination-anchor'] !== 'map') fail('Hillshade must remain geographically anchored.');
if (hillshade?.paint?.['hillshade-shadow-color'] !== '#0000004D') fail('Hillshade shadows are tinting exported colors.');
if (hillshade?.paint?.['hillshade-highlight-color'] !== '#FFFFFF4D') fail('Hillshade highlights are tinting exported colors.');

if ((layer('road-motorway-trunk')?.minzoom ?? 99) > 2) fail('Major highways enter too late for the supplied regional hierarchy.');
if ((layer('admin-0-boundary')?.minzoom ?? 99) > 0) fail('Country boundaries are unavailable at globe zoom.');

const allColors = collectHex(runtime.layers.map((candidate) => candidate.paint || {}));
if (allColors.size < 25) fail(`The exported globe palette was flattened to only ${allColors.size} colors.`);

if (!runtime.metadata?.['occumed:exported-cartography-restored']) fail('The exported-cartography restoration pass did not run.');
if (runtime.metadata?.['occumed:reference-color-system'] !== 'continuous-world-v10') fail('The continuous-world color pass did not run.');
if (runtime.metadata?.['occumed:palette-format'] !== 'fixed-hex-per-layer') fail('The per-layer fixed-hex palette marker is missing.');
if (runtime.metadata?.['occumed:layer-specific-palette'] !== true) fail('Layer-specific palette protection is missing.');
if (runtime.metadata?.['occumed:raster-relief-disabled'] !== true) fail('Raster relief protection is missing.');
if (runtime.metadata?.['occumed:reference-atmosphere'] !== true) fail('The reference atmosphere pass did not run.');
if (runtime.metadata?.['occumed:atmosphere-surface-wash-disabled'] !== true) fail('Atmosphere surface-wash protection is missing.');

if (failures.length) {
  console.error('Occu-Med globe parity validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Globe parity validated: dark space, strong white-blue atmosphere, layered land, clear blue water, and ${allColors.size} structure-specific colors.`);
