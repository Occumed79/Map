import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function layer(id) {
  return runtime.layers.find((entry) => entry.id === id);
}

assert(runtime.projection?.type === 'globe', 'Photo-reference build must use globe projection.');
assert(runtime.sky?.['sky-color'] === '#05080c', 'Photo-reference build must preserve dark outer space.');
assert(runtime.sky?.['horizon-color'] === 'rgba(250, 254, 255, 1)', 'The luminous globe rim is missing.');
assert(runtime.sky?.['fog-ground-blend'] === 0, 'Ground fog must remain disabled to prevent washout.');
assert(runtime.sky?.['horizon-fog-blend'] === 0, 'Horizon fog must remain disabled to prevent washout.');
assert(!runtime.light, 'Directional light must not be reintroduced.');
assert(!runtime.fog, 'Mapbox fog must not be copied into the MapLibre runtime.');

const land = layer('land');
assert(land?.paint?.['fill-color'] === '#e7e7d5', 'Opaque pale land base is missing.');
assert(land?.paint?.['fill-opacity'] === 1, 'Land must cover the relief raster at low zoom.');

const water = layer('water');
assert(Array.isArray(water?.paint?.['fill-color']), 'Water must use the calibrated zoom expression.');
assert(JSON.stringify(water.paint['fill-color']).includes('#55a7df'), 'Low-zoom ocean blue is missing.');
assert(JSON.stringify(water.paint['fill-color']).includes('#76b8e4'), 'High-zoom water blue is missing.');

const landcover = layer('landcover');
assert(Array.isArray(landcover?.paint?.['fill-color']), 'Landcover class palette is missing.');
assert(JSON.stringify(landcover.paint['fill-color']).includes('#8ecf76'), 'Forest green is missing.');
assert(JSON.stringify(landcover.paint['fill-color']).includes('#d7e1b6'), 'Agricultural land tone is missing.');

const relief = layer('occumed-shaded-relief');
assert(relief?.paint?.['raster-saturation'] === 0.32, 'Bathymetry calibration is missing.');
assert(relief?.paint?.['raster-contrast'] === 0.1, 'Bathymetry contrast calibration is missing.');

const hillshade = layer('occumed-hillshade');
assert(hillshade?.paint?.['hillshade-illumination-anchor'] === 'map', 'Hillshade must stay fixed to geography.');
assert(Array.isArray(hillshade?.paint?.['hillshade-exaggeration']), 'Zoom-aware hillshade is missing.');

for (const [sourceId, source] of Object.entries(runtime.sources || {})) {
  const serialized = JSON.stringify(source);
  assert(!/mapbox:\/\//i.test(serialized), `Source ${sourceId} still contains a mapbox:// URL.`);
  assert(!/api\.mapbox\.com/i.test(serialized), `Source ${sourceId} still calls api.mapbox.com.`);
}

assert(!/mapbox:\/\//i.test(runtime.sprite || ''), 'Runtime sprite must not use Mapbox.');
assert(!/api\.mapbox\.com/i.test(runtime.glyphs || ''), 'Runtime glyphs must not use Mapbox.');
assert(runtime.metadata?.['occumed:photo-reference-rebuild'] === true, 'Photo-reference metadata is missing.');
assert(runtime.metadata?.['occumed:mapbox-runtime-dependency'] === false, 'No-Mapbox dependency marker is missing.');

console.log('Photo-reference globe, palette, bathymetry, terrain, labels, and no-Mapbox checks passed.');
