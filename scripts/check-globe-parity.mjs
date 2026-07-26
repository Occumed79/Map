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
if (runtime.sky?.['horizon-fog-blend'] !== 0) fail('Horizon fog must remain disabled to prevent surface washout.');
if (runtime.sky?.['fog-ground-blend'] !== 0) fail('Ground fog must remain disabled to preserve surface contrast.');

const atmosphereBlend = runtime.sky?.['atmosphere-blend'];
if (Array.isArray(atmosphereBlend)) {
  const outputs = [];
  for (let index = 4; index < atmosphereBlend.length; index += 2) {
    if (typeof atmosphereBlend[index] === 'number') outputs.push(atmosphereBlend[index]);
  }
  if (outputs.some((value) => value > 0.2)) fail('Atmosphere opacity is high enough to overexpose the globe.');
}

const relief = layer('occumed-shaded-relief');
if (!relief) fail('The low-zoom relief layer is missing.');
if (relief?.paint?.['raster-saturation'] !== -1) fail('The independent relief raster is recoloring the exported palette.');
if (relief?.paint?.['raster-hue-rotate'] !== 0) fail('The independent relief raster is rotating exported hues.');
if ((relief?.paint?.['raster-contrast'] ?? 1) > 0.05) fail('Neutral relief contrast is high enough to distort exported swatches.');
if ((relief?.maxzoom ?? 99) > 8.5) fail('Raster relief persists too far into city zooms.');
const reliefStops = (relief?.paint?.['raster-opacity'] || []).filter((value) => typeof value === 'number');
if (reliefStops.some((value) => value > 8.5 ? false : value > 0.12 && value < 1)) {
  fail('The independent relief raster is opaque enough to recolor the globe.');
}

const landcover = layer('landcover');
if ((landcover?.minzoom ?? 99) !== 0) fail('Landcover is unavailable at globe zoom.');
if (!JSON.stringify(landcover?.paint?.['fill-opacity'] || []).includes('1')) {
  fail('Exported landcover swatches are being weakened at globe and regional zooms.');
}

const water = layer('water');
if (water?.paint?.['fill-color'] !== '#79BCEC') fail('The exact exported water blue changed.');
if (water?.paint?.['fill-opacity'] !== 1) fail('Water is blending into the land background.');

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
if (runtime.metadata?.['occumed:reference-color-system'] !== 'exact-exported-swatches-v9') fail('The exact exported swatch pass did not run.');
if (runtime.metadata?.['occumed:palette-format'] !== 'fixed-hex-per-layer') fail('The per-layer fixed-hex palette marker is missing.');
if (runtime.metadata?.['occumed:layer-specific-palette'] !== true) fail('Layer-specific palette protection is missing.');
if (runtime.metadata?.['occumed:colored-relief-disabled'] !== true) fail('Colored relief protection is missing.');

if (failures.length) {
  console.error('Occu-Med globe parity validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Globe parity validated: dark space, luminous rim, exact exported greens/blues, neutral terrain shading, and ${allColors.size} structure-specific colors.`);
