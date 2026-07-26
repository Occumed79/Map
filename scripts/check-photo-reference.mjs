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
assert(runtime.sky?.['sky-color'] === '#03070B', 'Photo-reference build must preserve dark outer space.');
assert(runtime.sky?.['horizon-color'] === 'rgba(245, 253, 255, 1)', 'The luminous globe rim is missing.');
assert(runtime.sky?.['fog-ground-blend'] === 0, 'Ground fog must remain disabled to prevent washout.');
assert(runtime.sky?.['horizon-fog-blend'] === 0, 'Horizon fog must remain disabled to prevent washout.');
assert(!runtime.light, 'Directional light must not be reintroduced.');
assert(!runtime.fog, 'Mapbox fog must not be copied into the MapLibre runtime.');

const land = layer('land');
assert(land?.paint?.['background-color'] === '#D8DCB9', 'The screenshot land hex is missing.');

const water = layer('water');
assert(water?.paint?.['fill-color'] === '#70AFE0', 'The screenshot ocean hex is missing.');
assert(Array.isArray(water?.paint?.['fill-opacity']), 'Water must retain a zoom opacity expression.');
assert(JSON.stringify(water.paint['fill-opacity']).includes('0.92'), 'The restrained low-zoom water blend is missing.');

const landcover = layer('landcover');
const landcoverColor = JSON.stringify(landcover?.paint?.['fill-color'] || []);
assert(landcoverColor.includes('#91CC78'), 'The screenshot forest hex is missing.');
assert(landcoverColor.includes('#D4D9A9'), 'The screenshot farmland hex is missing.');
assert(landcoverColor.includes('#E5E1CF'), 'The screenshot desert hex is missing.');
assert(!/["']hsl/i.test(landcoverColor), 'Landcover must use fixed hex colors, not HSL color guesses.');

const relief = layer('occumed-shaded-relief');
assert(relief?.paint?.['raster-saturation'] === -1, 'The hypsometric raster must be fully desaturated.');
assert(relief?.paint?.['raster-contrast'] === 0.06, 'The neutral relief contrast changed.');
assert(relief?.maxzoom === 8, 'Neutral relief must fade out by zoom 8.');
const reliefOpacity = JSON.stringify(relief?.paint?.['raster-opacity'] || []);
assert(reliefOpacity.includes('0.2'), 'The subtle low-zoom relief blend is missing.');
assert(!reliefOpacity.includes('0.72'), 'The radioactive high-opacity relief blend returned.');

const hillshade = layer('occumed-hillshade');
assert(hillshade?.paint?.['hillshade-illumination-anchor'] === 'map', 'Hillshade must stay fixed to geography.');
assert(hillshade?.paint?.['hillshade-shadow-color'] === '#52685B', 'The screenshot hillshade shadow hex is missing.');
assert(hillshade?.paint?.['hillshade-highlight-color'] === '#FFF8E8', 'The screenshot hillshade highlight hex is missing.');

const motorway = layer('road-motorway-trunk');
const motorwayFilter = JSON.stringify(motorway?.filter || []);
assert(motorwayFilter.includes('brunnel') && motorwayFilter.includes('none'), 'Surface roads still reject features with no brunnel value.');
assert(motorwayFilter.includes('motorway_link') && motorwayFilter.includes('trunk_link'), 'Specific highway link classes were not restored.');
assert(motorway?.paint?.['line-color'] === '#F48773', 'The screenshot coral motorway hex is missing.');
assert(layer('admin-0-boundary')?.paint?.['line-color'] === '#BF858E', 'The screenshot country-border hex is missing.');

const majorPlace = layer('settlement-major-label');
const majorFilter = JSON.stringify(majorPlace?.filter || []);
assert(majorFilter.includes('rank'), 'Major settlement ranking was stripped from the exported filter.');
assert(majorFilter.includes('city') && majorFilter.includes('town'), 'Major settlement classes were not mapped to OpenMapTiles.');
assert(JSON.stringify(majorPlace?.layout?.['text-font'] || []).includes('Open Sans Regular'), 'Major settlements are still using an overly heavy font.');
assert(majorPlace?.paint?.['text-color'] === '#303840', 'The screenshot dark-slate label hex is missing.');
assert(layer('state-label')?.paint?.['text-opacity'] === 0.5, 'The exported muted state-label hierarchy was lost.');

assert(runtime.metadata?.['occumed:exported-cartography-restored'] === true, 'Exported cartography restoration marker is missing.');
assert(runtime.metadata?.['occumed:reference-color-system'] === 'mapbox-screenshot-hex-v5', 'Screenshot hex color-system marker is missing.');
assert(runtime.metadata?.['occumed:live-visual-qa-pass'] === 5, 'Live visual-QA pass 5 marker is missing.');
assert(runtime.metadata?.['occumed:palette-format'] === 'fixed-hex', 'Fixed-hex palette marker is missing.');

for (const [sourceId, source] of Object.entries(runtime.sources || {})) {
  const serialized = JSON.stringify(source);
  assert(!/mapbox:\/\//i.test(serialized), `Source ${sourceId} still contains a mapbox:// URL.`);
  assert(!/api\.mapbox\.com/i.test(serialized), `Source ${sourceId} still calls api.mapbox.com.`);
}

assert(!/mapbox:\/\//i.test(runtime.sprite || ''), 'Runtime sprite must not use Mapbox.');
assert(!/api\.mapbox\.com/i.test(runtime.glyphs || ''), 'Runtime glyphs must not use Mapbox.');
assert(runtime.metadata?.['occumed:mapbox-runtime-dependency'] === false, 'No-Mapbox dependency marker is missing.');

console.log('Photo-reference validation passed: fixed screenshot hex palette, neutral relief, coral roads, muted borders, dark labels, and no Mapbox runtime.');
