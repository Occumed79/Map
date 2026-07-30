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
if (runtime.sky?.['horizon-color'] !== 'rgba(245, 253, 255, 0.98)') {
  fail('The narrow white horizon color changed.');
}
if (runtime.sky?.['fog-color'] !== 'rgba(184, 230, 255, 0.14)') {
  fail('The translucent cool-blue outer glow changed.');
}
if (!runtime.sky?.['atmosphere-blend']) fail('The globe atmosphere blend is missing.');
if (runtime.light) fail('Directional global light must remain disabled to prevent rotation-dependent washout.');
if ((runtime.sky?.['horizon-fog-blend'] ?? 1) > 0.1) {
  fail('Horizon fog is broad enough to wash over the visible hemisphere.');
}
if (runtime.sky?.['fog-ground-blend'] !== 0) fail('Ground fog must remain disabled to preserve surface contrast.');

const atmosphereOutputs = expressionOutputs(runtime.sky?.['atmosphere-blend']);
if (!atmosphereOutputs.some((value) => value >= 0.12)) {
  fail('The white-blue atmospheric edge is too weak to remain visible.');
}
if (atmosphereOutputs.some((value) => value > 0.2)) {
  fail('The atmosphere extends too far across the globe surface and reads as directional sunlight.');
}
if (atmosphereOutputs.at(-1) !== 0) {
  fail('The globe atmosphere does not disappear before detailed regional and city zooms.');
}

const horizonOutputs = expressionOutputs(runtime.sky?.['sky-horizon-blend']);
if (!horizonOutputs.some((value) => value >= 0.03)) {
  fail('The narrow luminous horizon rim is too weak.');
}
if (horizonOutputs.some((value) => value > 0.06)) {
  fail('The horizon blend is too broad to remain an edge-only bloom.');
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
if (Object.hasOwn(landcover || {}, 'maxzoom')) {
  fail('Landcover has a style-layer maxzoom cutoff instead of remaining continuous.');
}
if (layer('continent-label')?.layout?.visibility !== 'none') {
  fail('Multilingual continent aliases are cluttering the globe limb.');
}

const water = layer('water');
if (water?.paint?.['fill-color'] !== '#79BCEC') fail('The exact exported water blue changed.');
if (water?.paint?.['fill-opacity'] !== 1) fail('Water is blending into the land background.');

const waterDepth = layer('water-depth');
if (waterDepth?.['source-layer'] !== 'depth') fail('The continuous vector bathymetry layer is missing.');
if (Object.hasOwn(waterDepth || {}, 'maxzoom')) {
  fail('Bathymetry has a style-layer maxzoom cutoff instead of remaining subtly visible.');
}
const depthOpacity = waterDepth?.paint?.['fill-opacity'];
if (!Array.isArray(depthOpacity) || depthOpacity[0] !== 'max' || Number(depthOpacity[1]) < 0.06) {
  fail('Bathymetry can still collapse to zero at detailed navigation zooms.');
}
const waterDepthColors = JSON.stringify(waterDepth?.paint?.['fill-color'] || []);
for (const value of ['#79BCEC', '#6EB6EA', '#63B1E9']) {
  if (!waterDepthColors.includes(value)) fail(`The exported bathymetry swatch ${value} is missing.`);
}
if (runtime.layers.some((candidate) => candidate.type === 'hillshade')) {
  fail('The one-source style contains an external hillshade layer.');
}
if (Object.keys(runtime.sources || {}).length !== 1) fail('The globe style does not use exactly one browser source.');

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
if (runtime.metadata?.['occumed:atmosphere-edge-only'] !== true) fail('The edge-only atmosphere protection is missing.');
if (runtime.metadata?.['occumed:mapbox-style-contract-applied'] !== true) fail('The documented source/layer rendering contract did not run last.');

if (failures.length) {
  console.error('Occu-Med globe parity validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Globe parity validated: dark space, narrow white-blue edge bloom, neutral surface lighting, continuous landcover and bathymetry, clear blue water, and ${allColors.size} structure-specific colors.`);
