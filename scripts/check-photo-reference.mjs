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

function collectNonHexColors(value, colors = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectNonHexColors(child, colors);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectNonHexColors(child, colors);
  } else if (
    typeof value === 'string' &&
    (/^rgba?\(/i.test(value) || /^hsla?\(/i.test(value) || /^(black|white|transparent)$/i.test(value))
  ) {
    colors.push(value);
  }
  return colors;
}

assert(runtime.projection?.type === 'globe', 'Photo-reference build must use globe projection.');
assert(runtime.sky?.['sky-color'] === '#03070B', 'Photo-reference build must preserve dark outer space.');
assert(runtime.sky?.['horizon-color'] === '#F5FDFF', 'The luminous globe rim is missing.');
assert(runtime.sky?.['fog-ground-blend'] === 0, 'Ground fog must remain disabled to prevent washout.');
assert(runtime.sky?.['horizon-fog-blend'] === 0, 'Horizon fog must remain disabled to prevent washout.');
assert(!runtime.light, 'Directional light must not be reintroduced.');
assert(!runtime.fog, 'Mapbox fog must not be copied into the MapLibre runtime.');

const relief = layer('occumed-shaded-relief');
assert(relief?.paint?.['raster-saturation'] === 0.12, 'The restrained physical-relief saturation changed.');
assert(relief?.paint?.['raster-contrast'] === 0.09, 'The restrained physical-relief contrast changed.');
assert(relief?.paint?.['raster-hue-rotate'] === -6, 'The physical-relief hue correction changed.');
assert(relief?.maxzoom === 8.5, 'Physical relief must fade out before city zooms.');
const reliefOpacity = JSON.stringify(relief?.paint?.['raster-opacity'] || []);
assert(reliefOpacity.includes('0.32'), 'Visible low-zoom physical relief is missing.');
assert(!reliefOpacity.includes('0.72'), 'The fluorescent high-opacity relief blend returned.');
assert(relief?.paint?.['raster-saturation'] < 0.3, 'Physical relief is saturated enough to overpower structure colors.');

const landcover = layer('landcover');
const landcoverOpacity = JSON.stringify(landcover?.paint?.['fill-opacity'] || []);
assert((landcover?.minzoom ?? 99) === 0, 'Landcover must be available at globe zoom.');
assert(landcoverOpacity.includes('0.82') && landcoverOpacity.includes('0.86'), 'Visible globe and regional landcover opacity is missing.');

const landuse = layer('landuse');
assert((landuse?.minzoom ?? 99) <= 4.5, 'Landuse enters too late for the supplied regional reference.');
assert(JSON.stringify(landuse?.paint?.['fill-opacity'] || []).includes('0.56'), 'Regional landuse separation is too weak.');

const water = layer('water');
assert(water?.paint?.['fill-opacity'] === 1, 'Water must remain fully opaque instead of blending into the land background.');

const hillshade = layer('occumed-hillshade');
assert(hillshade?.minzoom === 1.5, 'Hillshade must begin early enough to shape the globe.');
assert(hillshade?.paint?.['hillshade-illumination-anchor'] === 'map', 'Hillshade must stay fixed to geography.');
assert(hillshade?.paint?.['hillshade-shadow-color'] === '#52685B', 'The terrain-shadow hex changed.');
assert(hillshade?.paint?.['hillshade-highlight-color'] === '#FFF8E8', 'The terrain-highlight hex changed.');
assert(JSON.stringify(hillshade?.paint?.['hillshade-exaggeration'] || []).includes('0.2'), 'Regional hillshade definition is too weak.');

const paintedLayers = runtime.layers.filter((candidate) => candidate.paint);
const allColors = collectHex(paintedLayers.map((candidate) => candidate.paint));
const nonHexColors = collectNonHexColors(paintedLayers.map((candidate) => candidate.paint));
assert(nonHexColors.length === 0, `Paint still contains non-hex color literals: ${nonHexColors.slice(0, 5).join(', ')}`);
assert(allColors.size >= 25, `The per-layer palette was flattened to only ${allColors.size} colors.`);
assert(runtime.metadata?.['occumed:distinct-layer-color-count'] === allColors.size, 'Stored distinct-color count does not match the built style.');

const roadStructureLayers = runtime.layers.filter(
  (candidate) =>
    candidate.type === 'line' &&
    ['road', 'structure'].includes(candidate.metadata?.['occumed:original-source-layer'])
);
const roadStructureColors = collectHex(roadStructureLayers.map((candidate) => candidate.paint || {}));
assert(roadStructureColors.size >= 6, `Road/tunnel/bridge colors were flattened to ${roadStructureColors.size} values.`);

const fillLayers = runtime.layers.filter((candidate) => ['fill', 'background', 'fill-extrusion'].includes(candidate.type));
const fillColors = collectHex(fillLayers.map((candidate) => candidate.paint || {}));
assert(fillColors.size >= 10, `Land, water, buildings, airports, and landuse were flattened to ${fillColors.size} fill colors.`);

const symbolLayers = runtime.layers.filter((candidate) => candidate.type === 'symbol');
const symbolColors = collectHex(symbolLayers.map((candidate) => candidate.paint || {}));
assert(symbolColors.size >= 4, `Label and icon colors were flattened to ${symbolColors.size} values.`);

const motorway = layer('road-motorway-trunk');
const motorwayFilter = JSON.stringify(motorway?.filter || []);
assert(motorwayFilter.includes('brunnel') && motorwayFilter.includes('none'), 'Surface roads still reject features with no brunnel value.');
assert(motorwayFilter.includes('motorway_link') && motorwayFilter.includes('trunk_link'), 'Specific highway link classes were not restored.');
assert((motorway?.minzoom ?? 99) <= 2, 'Major highways enter too late for regional reference views.');
assert((layer('road-primary')?.minzoom ?? 99) <= 3.75, 'Primary roads enter too late for regional reference views.');
assert((layer('road-secondary-tertiary')?.minzoom ?? 99) <= 5, 'Secondary roads enter too late for regional reference views.');

assert(layer('admin-0-boundary')?.paint?.['line-opacity'] === 0.82, 'Country boundaries are too faint.');
assert(layer('admin-1-boundary')?.paint?.['line-opacity'] === 0.58, 'State boundaries are too faint.');

const majorPlace = layer('settlement-major-label');
const majorFilter = JSON.stringify(majorPlace?.filter || []);
assert(majorFilter.includes('rank'), 'Major settlement ranking was stripped from the exported filter.');
assert(majorFilter.includes('city') && majorFilter.includes('town'), 'Major settlement classes were not mapped to OpenMapTiles.');
assert(JSON.stringify(majorPlace?.layout?.['text-font'] || []).includes('Open Sans Regular'), 'Major settlements are still using an overly heavy font.');
assert(layer('state-label')?.paint?.['text-opacity'] === 0.5, 'The exported muted state-label hierarchy was lost.');

assert(runtime.metadata?.['occumed:exported-cartography-restored'] === true, 'Exported cartography restoration marker is missing.');
assert(runtime.metadata?.['occumed:reference-color-system'] === 'exported-per-layer-visible-v7', 'Visible per-layer color-system marker is missing.');
assert(runtime.metadata?.['occumed:live-visual-qa-pass'] === 7, 'Live visual-QA pass 7 marker is missing.');
assert(runtime.metadata?.['occumed:palette-format'] === 'fixed-hex-per-layer', 'Per-layer fixed-hex palette marker is missing.');
assert(runtime.metadata?.['occumed:layer-specific-palette'] === true, 'Layer-specific palette protection is missing.');
assert(runtime.metadata?.['occumed:visible-low-zoom-cartography'] === true, 'Low-zoom visibility protection is missing.');

for (const [sourceId, source] of Object.entries(runtime.sources || {})) {
  const serialized = JSON.stringify(source);
  assert(!/mapbox:\/\//i.test(serialized), `Source ${sourceId} still contains a mapbox:// URL.`);
  assert(!/api\.mapbox\.com/i.test(serialized), `Source ${sourceId} still calls api.mapbox.com.`);
}

assert(!/mapbox:\/\//i.test(runtime.sprite || ''), 'Runtime sprite must not use Mapbox.');
assert(!/api\.mapbox\.com/i.test(runtime.glyphs || ''), 'Runtime glyphs must not use Mapbox.');
assert(runtime.metadata?.['occumed:mapbox-runtime-dependency'] === false, 'No-Mapbox dependency marker is missing.');

console.log(`Photo-reference validation passed: ${allColors.size} distinct per-layer hex colors with visible terrain, landcover, water, roads, and boundaries.`);
