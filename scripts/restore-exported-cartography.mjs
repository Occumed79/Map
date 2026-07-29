import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'style.json');
const runtimePath = path.join(root, 'public/style/occumed-open.json');

const original = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
const originalById = new Map((original.layers || []).map((layer) => [layer.id, layer]));

const clone = (value) => structuredClone(value);
const get = (key) => ['get', key];
const coalescedRank = (fallback) => ['coalesce', get('rank'), fallback];
const sourceUsesRoadSchema = (sourceLayer) =>
  ['road', 'structure', 'motorway_junction'].includes(sourceLayer);

const isRamp = ['==', ['to-string', ['coalesce', get('ramp'), 0]], '1'];
const constructionClasses = [
  'motorway_construction',
  'trunk_construction',
  'primary_construction',
  'secondary_construction',
  'tertiary_construction',
  'minor_construction',
  'path_construction',
  'service_construction',
  'track_construction',
  'raceway_construction'
];

const roadClassExpression = [
  'case',
  ['match', get('class'), constructionClasses, true, false],
  'construction',
  ['all', isRamp, ['==', get('class'), 'motorway']],
  'motorway_link',
  ['all', isRamp, ['==', get('class'), 'trunk']],
  'trunk_link',
  ['all', isRamp, ['==', get('class'), 'primary']],
  'primary_link',
  ['all', isRamp, ['==', get('class'), 'secondary']],
  'secondary_link',
  ['all', isRamp, ['==', get('class'), 'tertiary']],
  'tertiary_link',
  [
    'match',
    get('class'),
    'motorway',
    'motorway',
    'trunk',
    'trunk',
    'primary',
    'primary',
    'secondary',
    'secondary',
    'tertiary',
    'tertiary',
    ['minor', 'residential', 'unclassified'],
    'street',
    'living_street',
    'street_limited',
    'service',
    'service',
    'track',
    'track',
    'path',
    'path',
    'raceway',
    'street',
    ['busway', 'bus_guideway'],
    'primary',
    'rail',
    'major_rail',
    'transit',
    'transit',
    'ferry',
    'ferry',
    'motorway_junction',
    'motorway_junction',
    'street'
  ]
];

const roadTypeExpression = [
  'match',
  get('class'),
  'motorway_construction',
  'motorway',
  'trunk_construction',
  'trunk',
  'primary_construction',
  'primary',
  'secondary_construction',
  'secondary',
  'tertiary_construction',
  'tertiary',
  'minor_construction',
  'street',
  'path_construction',
  ['coalesce', get('subclass'), 'path'],
  'service_construction',
  'service',
  'track_construction',
  'track',
  'raceway_construction',
  'street',
  'path',
  ['coalesce', get('subclass'), 'path'],
  ['rail', 'transit'],
  ['coalesce', get('subclass'), get('class')],
  get('class')
];

const placeClassExpression = [
  'match',
  get('class'),
  'continent',
  'continent',
  'country',
  'country',
  ['state', 'province'],
  'state',
  ['city', 'town', 'village', 'hamlet', 'isolated_dwelling'],
  'settlement',
  ['borough', 'suburb', 'quarter', 'neighbourhood'],
  'settlement_subdivision',
  get('class')
];

const landcoverClassExpression = [
  'match',
  get('class'),
  'farmland',
  'crop',
  'ice',
  'snow',
  get('class')
];

const rawLandKind = ['coalesce', get('subclass'), get('class'), ''];
const landuseClassExpression = [
  'match',
  rawLandKind,
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

const overlayClassExpression = [
  'match',
  rawLandKind,
  ['national_park', 'nature_reserve', 'protected_area'],
  'national_park',
  ['wetland', 'wetland_noveg', 'marsh', 'swamp', 'bog', 'saltmarsh', 'tidalflat'],
  'wetland',
  ['park', 'forest', 'wood'],
  'national_park',
  get('class')
];

const fontMap = new Map([
  ['DIN Pro Regular', 'Open Sans Regular'],
  ['DIN Pro Medium', 'Open Sans Regular'],
  ['DIN Pro Bold', 'Open Sans Semibold'],
  ['DIN Pro Italic', 'Open Sans Italic'],
  ['Arial Unicode MS Regular', 'Noto Sans Regular'],
  ['Arial Unicode MS Bold', 'Noto Sans Semibold']
]);

function translatedNameGet(key) {
  const language = key.slice('name_'.length).replaceAll('_', '-');
  return ['coalesce', get(`name:${language}`), get('name'), get('name:latin'), ''];
}

function translatedGet(key, context) {
  if (/^name_[A-Za-z0-9_-]+$/.test(key)) return translatedNameGet(key);
  if (key === 'name') return ['coalesce', get('name'), get('name:latin'), get('name:nonlatin'), ''];

  if (key === 'class') {
    if (sourceUsesRoadSchema(context.sourceLayer)) return clone(roadClassExpression);
    if (context.sourceLayer === 'place_label') return clone(placeClassExpression);
    if (context.sourceLayer === 'landcover') return clone(landcoverClassExpression);
    if (context.sourceLayer === 'landuse') return clone(landuseClassExpression);
    if (context.sourceLayer === 'landuse_overlay') return clone(overlayClassExpression);
    return get('class');
  }

  if (key === 'type') {
    if (sourceUsesRoadSchema(context.sourceLayer)) return clone(roadTypeExpression);
    if (context.sourceLayer === 'place_label') return get('class');
    if (['landuse', 'landuse_overlay', 'poi_label', 'transit_stop_label'].includes(context.sourceLayer)) {
      return ['coalesce', get('subclass'), get('class'), ''];
    }
    if (['natural_label', 'airport_label'].includes(context.sourceLayer)) return get('class');
    return get('class');
  }

  if (key === 'structure') return ['coalesce', get('brunnel'), 'none'];
  if (key === 'oneway' && sourceUsesRoadSchema(context.sourceLayer)) {
    return ['case', ['match', get('oneway'), [1, -1], true, false], 'true', 'false'];
  }

  if (['filterrank', 'symbolrank', 'sizerank', 'localrank'].includes(key)) {
    const fallback = ['landuse', 'landuse_overlay'].includes(context.sourceLayer) ? 1 : 99;
    return coalescedRank(fallback);
  }

  const directMappings = {
    shield: 'ref',
    house_num: 'housenumber',
    height: 'render_height',
    min_height: 'render_min_height',
    elevation_m: 'ele',
    iso_3166_1: 'iso_a2',
    mode: 'subclass',
    stop_type: 'subclass'
  };
  if (directMappings[key]) return get(directMappings[key]);

  if (key === 'text_anchor') return ['coalesce', get('text_anchor'), 'center'];
  if (key === 'reflen') return ['length', ['to-string', ['coalesce', get('ref'), '']]];
  if (key === 'maki' || key === 'maki_beta') {
    return ['coalesce', get('subclass'), get('class'), 'marker'];
  }
  if (key === 'extrude') return ['case', ['has', 'render_height'], 'true', 'false'];
  if (key === 'abbr') return ['coalesce', get('name:short'), get('name'), ''];
  if (key === 'worldview') return 'US';
  if (key === 'disputed') return 0;
  return get(key);
}

function translatedHas(key) {
  if (/^name_[A-Za-z0-9_-]+$/.test(key)) {
    const language = key.slice('name_'.length).replaceAll('_', '-');
    return ['any', ['has', `name:${language}`], ['has', 'name']];
  }

  const directMappings = {
    structure: 'brunnel',
    shield: 'ref',
    house_num: 'housenumber',
    height: 'render_height',
    min_height: 'render_min_height',
    elevation_m: 'ele',
    filterrank: 'rank',
    symbolrank: 'rank',
    sizerank: 'rank',
    localrank: 'rank'
  };
  if (key === 'extrude') return ['has', 'render_height'];
  return ['has', directMappings[key] || key];
}

function rewriteExpression(value, context) {
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, rewriteExpression(child, context)])
      );
    }
    return value;
  }

  const [operator, ...rest] = value;
  if (operator === 'get' && typeof rest[0] === 'string') return translatedGet(rest[0], context);
  if (operator === 'has' && typeof rest[0] === 'string') return translatedHas(rest[0]);
  return [operator, ...rest.map((child) => rewriteExpression(child, context))];
}

function rewriteFonts(value) {
  if (Array.isArray(value)) return value.map(rewriteFonts);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteFonts(child)]));
  }
  return typeof value === 'string' ? fontMap.get(value) || value : value;
}

function restoreZoomRange(runtimeLayer, originalLayer) {
  if ('minzoom' in originalLayer) runtimeLayer.minzoom = originalLayer.minzoom;
  else delete runtimeLayer.minzoom;
  if ('maxzoom' in originalLayer) runtimeLayer.maxzoom = originalLayer.maxzoom;
  else delete runtimeLayer.maxzoom;
}

let restoredLayers = 0;
let restoredFilters = 0;
for (const runtimeLayer of runtime.layers || []) {
  const originalLayer = originalById.get(runtimeLayer.id);
  if (!originalLayer) continue;

  if (
    originalLayer['source-layer'] === 'landuse_overlay' &&
    /wetland/i.test(runtimeLayer.id)
  ) {
    runtimeLayer['source-layer'] = 'landcover';
    runtimeLayer.metadata = {
      ...(runtimeLayer.metadata || {}),
      'occumed:open-source-layer': 'landcover',
      'occumed:wetland-source-repaired': true
    };
  }

  const context = {
    sourceLayer: originalLayer['source-layer'],
    targetSourceLayer: runtimeLayer['source-layer'],
    layerId: originalLayer.id
  };

  restoreZoomRange(runtimeLayer, originalLayer);
  runtimeLayer.layout = rewriteFonts(rewriteExpression(clone(originalLayer.layout || {}), context));
  runtimeLayer.paint = rewriteExpression(clone(originalLayer.paint || {}), context);

  if (
    ['road', 'structure', 'place_label', 'landuse', 'landuse_overlay'].includes(
      originalLayer['source-layer']
    ) &&
    originalLayer.filter
  ) {
    runtimeLayer.filter = rewriteExpression(clone(originalLayer.filter), context);
    restoredFilters += 1;
  }

  runtimeLayer.metadata = {
    ...(runtimeLayer.metadata || {}),
    'occumed:exported-layout-paint-restored': true
  };
  restoredLayers += 1;
}

const water = runtime.layers.find((layer) => layer.id === 'water');
if (!water) throw new Error('The exported water layer is missing after cartography restoration.');
water.paint['fill-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0,
  0.8,
  3,
  0.86,
  6,
  0.94,
  8,
  1
];

for (const layer of runtime.layers || []) {
  if (layer.type !== 'symbol') continue;
  const haloWidth = layer.paint?.['text-halo-width'];
  if (typeof haloWidth === 'number' && haloWidth > 1.25) {
    layer.paint['text-halo-width'] = 1.25;
  }
}

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:exported-cartography-restored': true,
  'occumed:road-schema-repair': 'brunnel-none-and-specific-link-classes',
  'occumed:place-rank-hierarchy-restored': true,
  'occumed:live-visual-qa-pass': 3
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(
  `Restored exported layout and paint for ${restoredLayers} layers and repaired ${restoredFilters} schema-sensitive filters.`
);
