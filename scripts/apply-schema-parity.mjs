import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const clone = (value) => structuredClone(value);
const get = (key) => ['get', key];
const rawKind = ['coalesce', get('subclass'), get('class'), ''];

const landuseClass = [
  'match',
  rawKind,
  ['farmland', 'farm', 'farmyard', 'orchard', 'vineyard', 'plant_nursery'],
  'agriculture',
  ['forest', 'wood'],
  'wood',
  ['grass', 'grassland', 'meadow'],
  'grass',
  ['scrub', 'heath'],
  'scrub',
  'glacier',
  'glacier',
  ['pitch', 'stadium', 'sports_centre'],
  'pitch',
  ['sand', 'beach', 'dune'],
  'sand',
  ['park', 'garden', 'recreation_ground', 'playground', 'zoo', 'golf_course'],
  'park',
  ['aerodrome', 'airport'],
  'airport',
  ['cemetery', 'grave_yard'],
  'cemetery',
  ['hospital', 'clinic'],
  'hospital',
  ['school', 'university', 'college', 'kindergarten'],
  'school',
  ['commercial', 'retail'],
  'commercial_area',
  ['industrial', 'quarry'],
  'industrial',
  ['rock', 'bare_rock', 'scree'],
  'rock',
  'residential',
  'residential',
  get('class')
];

const overlayClass = [
  'match',
  rawKind,
  ['national_park', 'nature_reserve', 'protected_area'],
  'national_park',
  ['wetland', 'wetland_noveg', 'marsh', 'swamp', 'bog'],
  'wetland',
  ['park', 'forest', 'wood'],
  'national_park',
  get('class')
];

function rewriteGetClass(value, replacement) {
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, rewriteGetClass(child, replacement)])
      );
    }
    return value;
  }

  if (value.length === 2 && value[0] === 'get' && value[1] === 'class') {
    return clone(replacement);
  }

  return value.map((child) => rewriteGetClass(child, replacement));
}

let normalizedLandLayers = 0;
for (const layer of runtime.layers || []) {
  const originalSource = layer.metadata?.['occumed:original-source-layer'];
  let replacement = null;

  if (originalSource === 'landuse') replacement = landuseClass;
  if (originalSource === 'landuse_overlay') replacement = overlayClass;
  if (!replacement) continue;

  if (layer.filter) layer.filter = rewriteGetClass(layer.filter, replacement);
  if (layer.layout) layer.layout = rewriteGetClass(layer.layout, replacement);
  if (layer.paint) layer.paint = rewriteGetClass(layer.paint, replacement);

  layer.metadata = {
    ...(layer.metadata || {}),
    'occumed:open-class-normalized': true
  };
  normalizedLandLayers += 1;
}

const placeFilters = {
  'continent-label': ['==', get('class'), 'continent'],
  'country-label': ['==', get('class'), 'country'],
  'state-label': ['match', get('class'), ['state', 'province'], true, false],
  'settlement-major-label': ['match', get('class'), ['city', 'town'], true, false],
  'settlement-minor-label': ['match', get('class'), ['village', 'hamlet'], true, false],
  'settlement-subdivision-label': [
    'match',
    get('class'),
    ['suburb', 'neighbourhood', 'quarter'],
    true,
    false
  ]
};

let normalizedPlaceLayers = 0;
for (const [id, filter] of Object.entries(placeFilters)) {
  const layer = runtime.layers.find((candidate) => candidate.id === id);
  if (!layer) continue;

  layer.filter = filter;
  layer.metadata = {
    ...(layer.metadata || {}),
    'occumed:open-place-filter': true
  };
  normalizedPlaceLayers += 1;
}

let optionalIconLayers = 0;
for (const layer of runtime.layers || []) {
  const originalSource = layer.metadata?.['occumed:original-source-layer'];
  if (!['poi_label', 'transit_stop_label', 'airport_label'].includes(originalSource)) continue;
  if (layer.type !== 'symbol') continue;

  layer.layout ||= {};
  layer.layout['icon-optional'] = true;
  layer.layout['text-optional'] = false;
  optionalIconLayers += 1;
}

const water = runtime.layers.find((layer) => layer.id === 'water');
if (!water) throw new Error('The exported water layer is missing from the runtime style.');
water.paint ||= {};
water.paint['fill-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0,
  0.74,
  3,
  0.78,
  5,
  0.9,
  7,
  1
];
water.metadata = {
  ...(water.metadata || {}),
  'occumed:purpose': 'vivid water with low-zoom bathymetry showing through'
};

const landcover = runtime.layers.find((layer) => layer.id === 'landcover');
if (!landcover) throw new Error('The exported landcover layer is missing from the runtime style.');
landcover.paint ||= {};
landcover.paint['fill-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0,
  0.92,
  6,
  0.88,
  8,
  0.82,
  12,
  0
];
landcover.metadata = {
  ...(landcover.metadata || {}),
  'occumed:purpose': 'strong exported vegetation hierarchy over open landcover data'
};

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:open-schema-parity': true,
  'occumed:cartography-parity-pass': 1
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(
  `Applied open-schema parity to ${normalizedLandLayers} land layers, ${normalizedPlaceLayers} place-label layers, and ${optionalIconLayers} icon-label layers.`
);
