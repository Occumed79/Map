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
assert(land?.paint?.['background-color'] === 'hsl(68, 28%, 83%)', 'The corrected warm green land base is missing.');

const water = layer('water');
assert(water?.paint?.['fill-color'] === 'hsl(205, 76%, 66%)', 'The richer reference water color is missing.');
assert(Array.isArray(water?.paint?.['fill-opacity']), 'Water must reveal low-zoom bathymetry through a zoom opacity expression.');
assert(JSON.stringify(water.paint['fill-opacity']).includes('0.9'), 'Corrected low-zoom water transparency is missing.');

const landcover = layer('landcover');
const landcoverColor = JSON.stringify(landcover?.paint?.['fill-color'] || []);
assert(landcoverColor.includes('hsla(103, 48%, 57%, 0.82)'), 'The corrected forest color is missing.');
assert(landcoverColor.includes('hsla(72, 48%, 69%, 0.62)'), 'The corrected agricultural color is missing.');
assert(JSON.stringify(landcover?.paint?.['fill-opacity'] || []).includes('0.82'), 'The corrected landcover hierarchy is missing.');

const relief = layer('occumed-shaded-relief');
assert(relief?.paint?.['raster-saturation'] === 0.92, 'Reference relief saturation is missing.');
assert(relief?.paint?.['raster-contrast'] === 0.18, 'Reference relief contrast is missing.');
assert(relief?.paint?.['raster-hue-rotate'] === -8, 'Reference relief hue correction is missing.');
assert(relief?.maxzoom === 9.5, 'Relief is disappearing too early at regional zooms.');

const hillshade = layer('occumed-hillshade');
assert(hillshade?.paint?.['hillshade-illumination-anchor'] === 'map', 'Hillshade must stay fixed to geography.');
assert(Array.isArray(hillshade?.paint?.['hillshade-exaggeration']), 'Zoom-aware hillshade is missing.');
assert(JSON.stringify(hillshade.paint['hillshade-exaggeration']).includes('0.34'), 'Regional terrain definition is too weak.');

const motorway = layer('road-motorway-trunk');
const motorwayFilter = JSON.stringify(motorway?.filter || []);
assert(motorwayFilter.includes('brunnel') && motorwayFilter.includes('none'), 'Surface roads still reject features with no brunnel value.');
assert(motorwayFilter.includes('motorway_link') && motorwayFilter.includes('trunk_link'), 'Specific highway link classes were not restored.');

const majorPlace = layer('settlement-major-label');
const majorFilter = JSON.stringify(majorPlace?.filter || []);
assert(majorFilter.includes('rank'), 'Major settlement ranking was stripped from the exported filter.');
assert(majorFilter.includes('city') && majorFilter.includes('town'), 'Major settlement classes were not mapped to OpenMapTiles.');
assert(JSON.stringify(majorPlace?.layout?.['text-font'] || []).includes('Open Sans Regular'), 'Major settlements are still using an overly heavy font.');
assert(layer('state-label')?.paint?.['text-opacity'] === 0.5, 'The exported muted state-label hierarchy was lost.');

assert(runtime.metadata?.['occumed:exported-cartography-restored'] === true, 'Exported cartography restoration marker is missing.');
assert(runtime.metadata?.['occumed:reference-color-system'] === 'mapbox-photo-reference-v4', 'Reference color system marker is missing.');
assert(runtime.metadata?.['occumed:live-visual-qa-pass'] === 4, 'Live visual-QA pass 4 marker is missing.');

for (const [sourceId, source] of Object.entries(runtime.sources || {})) {
  const serialized = JSON.stringify(source);
  assert(!/mapbox:\/\//i.test(serialized), `Source ${sourceId} still contains a mapbox:// URL.`);
  assert(!/api\.mapbox\.com/i.test(serialized), `Source ${sourceId} still calls api.mapbox.com.`);
}

assert(!/mapbox:\/\//i.test(runtime.sprite || ''), 'Runtime sprite must not use Mapbox.');
assert(!/api\.mapbox\.com/i.test(runtime.glyphs || ''), 'Runtime glyphs must not use Mapbox.');
assert(runtime.metadata?.['occumed:mapbox-runtime-dependency'] === false, 'No-Mapbox dependency marker is missing.');

console.log('Photo-reference validation passed: corrected land, water, relief, terrain, roads, label ranks, atmosphere, and no-Mapbox runtime.');
