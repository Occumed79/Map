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
assert(runtime.sky?.['sky-color'] === '#181A1D', 'Photo-reference build must preserve the dark charcoal reference space.');
assert(
  runtime.sky?.['horizon-color'] === 'rgba(245, 253, 255, 0.98)',
  'The narrow luminous globe rim is missing.'
);
assert(
  runtime.sky?.['fog-color'] === 'rgba(184, 230, 255, 0.14)',
  'The cool-blue outer atmosphere bloom is missing.'
);
assert(runtime.sky?.['fog-ground-blend'] === 0, 'Ground fog must remain disabled.');
assert(runtime.sky?.['horizon-fog-blend'] === 0.08, 'The narrow edge bloom strength changed.');
assert(!runtime.light, 'Directional light must not be reintroduced.');
assert(!runtime.fog, 'Mapbox fog must not be copied into the MapLibre runtime.');
assert(runtime.metadata?.['occumed:atmosphere-edge-only'] === true, 'The edge-only atmosphere protection marker is missing.');

assert(layer('land')?.paint?.['background-color'] === '#79BCEC', 'The supplied Studio ocean blue changed.');
assert(layer('occumed-land-surface')?.paint?.['fill-color'] === '#E0E0D1', 'The supplied Studio land base changed.');
assert(layer('water')?.paint?.['fill-color'] === '#79BCEC', 'The exact exported water swatch changed.');
assert(layer('water-shadow')?.paint?.['fill-color'] === '#7293EE', 'The exact exported water-shadow swatch changed.');
assert(layer('wetland')?.paint?.['fill-color'] === '#A5CAD6', 'The supplied Studio wetland swatch changed.');
assert(layer('national-park')?.paint?.['fill-color'] === '#A5CC8E', 'The exact exported national-park swatch changed.');

const landcover = layer('landcover');
const landcoverColor = JSON.stringify(landcover?.paint?.['fill-color'] || []);
for (const required of ['#83CC66CC', '#A3D48799', '#D1DD8899', '#B4DE9C99', '#EDF3F8', '#E0E0D1', '#A0D382']) {
  assert(landcoverColor.includes(required), `The exact exported landcover swatch ${required} is missing.`);
}
assert((landcover?.minzoom ?? 99) === 0, 'Landcover must be available at globe zoom.');
assert(layer('continent-label')?.layout?.visibility === 'none', 'Noisy continent aliases returned to the globe limb.');
assert(JSON.stringify(landcover?.paint?.['fill-opacity'] || []).includes('1'), 'Landcover swatches are being weakened by zoom opacity.');
assert(layer('landuse')?.paint?.['fill-opacity'] === 1, 'Detailed landuse swatches are being weakened by extra opacity.');
assert(layer('water')?.paint?.['fill-opacity'] === 1, 'Water must remain fully opaque.');
assert(layer('water-depth')?.['source-layer'] === 'depth', 'The reference bathymetry layer is missing.');
for (const required of ['#79BCEC59', '#5AACE759', '#3B9DE359']) {
  assert(
    JSON.stringify(layer('water-depth')?.paint?.['fill-color'] || []).includes(required),
    `The exported bathymetry swatch ${required} is missing.`
  );
}

assert(!runtime.layers.some((candidate) => candidate.type === 'raster'), 'A raster fallback basemap was reintroduced.');

const hillshade = layer('occumed-hillshade');
assert(hillshade?.minzoom === 1.5, 'Hillshade must begin early enough to shape the globe.');
assert(hillshade?.paint?.['hillshade-illumination-anchor'] === 'map', 'Hillshade must stay fixed to geography.');
assert(hillshade?.paint?.['hillshade-shadow-color'] === '#0000004D', 'Hillshade shadows are tinting the exported palette.');
assert(hillshade?.paint?.['hillshade-highlight-color'] === '#FFFFFF4D', 'Hillshade highlights are tinting the exported palette.');

const paintedLayers = runtime.layers.filter((candidate) => candidate.paint);
const allColors = collectHex(paintedLayers.map((candidate) => candidate.paint));
const nonHexColors = collectNonHexColors(paintedLayers.map((candidate) => candidate.paint));
assert(nonHexColors.length === 0, `Paint still contains non-hex color literals: ${nonHexColors.slice(0, 5).join(', ')}`);
assert(allColors.size >= 25, `The per-layer palette was flattened to only ${allColors.size} colors.`);

const roadStructureLayers = runtime.layers.filter(
  (candidate) => candidate.type === 'line' && ['road', 'structure'].includes(candidate.metadata?.['occumed:original-source-layer'])
);
const roadStructureColors = collectHex(roadStructureLayers.map((candidate) => candidate.paint || {}));
assert(roadStructureColors.size >= 6, `Road/tunnel/bridge colors were flattened to ${roadStructureColors.size} values.`);

const fillLayers = runtime.layers.filter((candidate) => ['fill', 'background', 'fill-extrusion'].includes(candidate.type));
const fillColors = collectHex(fillLayers.map((candidate) => candidate.paint || {}));
assert(fillColors.size >= 10, `Land, water, buildings, airports, and landuse were flattened to ${fillColors.size} fill colors.`);

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
assert(runtime.metadata?.['occumed:reference-color-system'] === 'continuous-world-v10', 'Continuous-world color marker is missing.');
assert(runtime.metadata?.['occumed:live-visual-qa-pass'] === 10, 'Continuous-world visual pass marker is missing.');
assert(runtime.metadata?.['occumed:palette-format'] === 'fixed-hex-per-layer', 'Per-layer fixed-hex palette marker is missing.');
assert(runtime.metadata?.['occumed:layer-specific-palette'] === true, 'Layer-specific palette protection is missing.');
assert(runtime.metadata?.['occumed:raster-relief-disabled'] === true, 'Raster relief protection is missing.');
assert(runtime.metadata?.['occumed:high-dpi-vector-clarity'] === true, 'High-DPI clarity protection is missing.');

for (const [sourceId, source] of Object.entries(runtime.sources || {})) {
  const serialized = JSON.stringify(source);
  assert(!/mapbox:\/\//i.test(serialized), `Source ${sourceId} still contains a mapbox:// URL.`);
  assert(!/api\.mapbox\.com/i.test(serialized), `Source ${sourceId} still calls api.mapbox.com.`);
}
assert(!/mapbox:\/\//i.test(runtime.sprite || ''), 'Runtime sprite must not use Mapbox.');
assert(!/api\.mapbox\.com/i.test(runtime.glyphs || ''), 'Runtime glyphs must not use Mapbox.');
assert(runtime.metadata?.['occumed:mapbox-runtime-dependency'] === false, 'No-Mapbox dependency marker is missing.');

console.log(`Reference guard passed: supplied Studio land and water, narrow edge-only atmosphere, high-DPI vector clarity, and ${allColors.size} distinct colors.`);
