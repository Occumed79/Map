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
assert(runtime.sky?.['sky-color'] === '#03070b', 'Photo-reference build must preserve dark outer space.');
assert(runtime.sky?.['horizon-color'] === 'rgba(245, 253, 255, 1)', 'The luminous globe rim is missing.');
assert(runtime.sky?.['fog-ground-blend'] === 0, 'Ground fog must remain disabled to prevent washout.');
assert(runtime.sky?.['horizon-fog-blend'] === 0, 'Horizon fog must remain disabled to prevent washout.');
assert(!runtime.light, 'Directional light must not be reintroduced.');
assert(!runtime.fog, 'Mapbox fog must not be copied into the MapLibre runtime.');

const land = layer('land');
assert(land?.paint?.['background-color'] === 'hsl(72, 38%, 79%)', 'Pale yellow-green land background is missing.');
assert(land?.paint?.['background-opacity'] === 1, 'Land background must remain fully opaque.');

const water = layer('water');
assert(Array.isArray(water?.paint?.['fill-color']), 'Water must use the calibrated zoom color expression.');
assert(Array.isArray(water?.paint?.['fill-opacity']), 'Water must reveal low-zoom bathymetry through a zoom opacity expression.');
assert(JSON.stringify(water.paint['fill-color']).includes('#3b9edb'), 'Saturated low-zoom ocean blue is missing.');
assert(JSON.stringify(water.paint['fill-color']).includes('#70bce8'), 'High-zoom water blue is missing.');
assert(JSON.stringify(water.paint['fill-opacity']).includes('0.82'), 'Low-zoom ocean opacity correction is missing.');

const landcover = layer('landcover');
assert(Array.isArray(landcover?.paint?.['fill-color']), 'Landcover class palette is missing.');
assert(JSON.stringify(landcover.paint['fill-color']).includes('#79c963'), 'Forest green is missing.');
assert(JSON.stringify(landcover.paint['fill-color']).includes('#d9e2a9'), 'Agricultural land tone is missing.');

const relief = layer('occumed-shaded-relief');
assert(relief?.paint?.['raster-saturation'] === 0.72, 'Bathymetry and relief vividness calibration is missing.');
assert(relief?.paint?.['raster-contrast'] === 0.16, 'Bathymetry contrast calibration is missing.');
assert(Array.isArray(relief?.paint?.['raster-opacity']), 'Relief must use zoom-aware opacity.');

const hillshade = layer('occumed-hillshade');
assert(hillshade?.paint?.['hillshade-illumination-anchor'] === 'map', 'Hillshade must stay fixed to geography.');
assert(Array.isArray(hillshade?.paint?.['hillshade-exaggeration']), 'Zoom-aware hillshade is missing.');

assert(layer('road-motorway-trunk')?.minzoom <= 1.5, 'Major roads must enter early enough to match the reference hierarchy.');
assert(layer('country-label')?.minzoom === 0, 'Country labels must remain visible at globe zoom.');
assert(runtime.metadata?.['occumed:live-visual-qa-pass'] === 2, 'Live visual-QA pass marker is missing.');

for (const [sourceId, source] of Object.entries(runtime.sources || {})) {
  const serialized = JSON.stringify(source);
  assert(!/mapbox:\/\//i.test(serialized), `Source ${sourceId} still contains a mapbox:// URL.`);
  assert(!/api\.mapbox\.com/i.test(serialized), `Source ${sourceId} still calls api.mapbox.com.`);
}

assert(!/mapbox:\/\//i.test(runtime.sprite || ''), 'Runtime sprite must not use Mapbox.');
assert(!/api\.mapbox\.com/i.test(runtime.glyphs || ''), 'Runtime glyphs must not use Mapbox.');
assert(runtime.metadata?.['occumed:photo-reference-rebuild'] === true, 'Photo-reference metadata is missing.');
assert(runtime.metadata?.['occumed:mapbox-runtime-dependency'] === false, 'No-Mapbox dependency marker is missing.');

console.log('Photo-reference globe, ocean blend, palette, terrain, road hierarchy, labels, and no-Mapbox checks passed.');
