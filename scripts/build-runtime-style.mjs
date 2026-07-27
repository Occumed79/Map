import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'style.json');
const outputDir = path.join(root, 'public/style');
const outputPath = path.join(outputDir, 'occumed-open.json');
const reportPath = path.join(outputDir, 'compatibility-report.json');

const vectorTilesUrl =
  process.env.OCCUMED_VECTOR_TILES_URL ||
  '__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf';
const glyphsUrl =
  process.env.OCCUMED_GLYPHS_URL ||
  'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';
const terrainUrl =
  process.env.OCCUMED_TERRAIN_URL ||
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const original = JSON.parse(await fs.readFile(sourcePath, 'utf8'));

const fontMap = new Map([
  ['DIN Pro Regular', 'Open Sans Regular'],
  ['DIN Pro Medium', 'Open Sans Semibold'],
  ['DIN Pro Bold', 'Open Sans Bold'],
  ['DIN Pro Italic', 'Open Sans Italic'],
  ['Arial Unicode MS Regular', 'Open Sans Regular']
]);

const get = (key) => ['get', key];
const clone = (value) => structuredClone(value);

const roadClassExpression = [
  'case',
  ['==', get('brunnel'), 'ferry'],
  'ferry',
  ['all', ['==', get('class'), 'motorway'], ['==', get('ramp'), 1]],
  'motorway_link',
  [
    'all',
    ['match', get('class'), ['trunk', 'primary', 'secondary', 'tertiary'], true, false],
    ['==', get('ramp'), 1]
  ],
  'link',
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
    'minor',
    'street',
    'service',
    'service',
    'track',
    'track',
    'path',
    'path',
    'pedestrian',
    'path',
    'steps',
    'path',
    'raceway',
    'street',
    'rail',
    'major_rail',
    'transit',
    'transit',
    'ferry',
    'ferry',
    'cable_car',
    'aerialway',
    'gondola',
    'aerialway',
    'street'
  ]
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

function sourceContextUsesRoadSchema(sourceLayer) {
  return ['road', 'structure', 'motorway_junction'].includes(sourceLayer);
}

function translatedNameGet(key) {
  const language = key.slice('name_'.length).replaceAll('_', '-');
  return ['coalesce', get(`name:${language}`), get('name'), get('name:latin'), ''];
}

function translatedGet(key, context) {
  if (/^name_[A-Za-z0-9_-]+$/.test(key)) return translatedNameGet(key);

  if (key === 'name') {
    return ['coalesce', get('name'), get('name:latin'), get('name:nonlatin'), ''];
  }

  if (key === 'class') {
    if (sourceContextUsesRoadSchema(context.sourceLayer)) return clone(roadClassExpression);
    if (context.sourceLayer === 'landcover') return clone(landcoverClassExpression);
    return get('class');
  }

  if (key === 'type') {
    if (sourceContextUsesRoadSchema(context.sourceLayer)) return clone(roadClassExpression);
    if (['place_label', 'natural_label', 'airport_label'].includes(context.sourceLayer)) {
      return get('class');
    }
    if (['poi_label', 'transit_stop_label'].includes(context.sourceLayer)) {
      return ['coalesce', get('subclass'), get('class'), ''];
    }
    return get('class');
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
    localrank: 'rank',
    iso_3166_1: 'iso_a2',
    mode: 'subclass',
    stop_type: 'subclass'
  };

  if (directMappings[key]) return get(directMappings[key]);

  if (key === 'reflen') {
    return ['length', ['to-string', ['coalesce', get('ref'), '']]];
  }

  if (key === 'maki' || key === 'maki_beta') {
    return ['coalesce', get('subclass'), get('class'), 'marker'];
  }

  if (key === 'extrude') {
    return ['case', ['has', 'render_height'], 'true', 'false'];
  }

  if (key === 'abbr') {
    return ['coalesce', get('name:short'), get('name'), ''];
  }

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
  if (operator === 'get' && typeof rest[0] === 'string') {
    return translatedGet(rest[0], context);
  }
  if (operator === 'has' && typeof rest[0] === 'string') {
    return translatedHas(rest[0]);
  }

  return [operator, ...rest.map((child) => rewriteExpression(child, context))];
}

function rewriteFontValue(value) {
  if (Array.isArray(value)) return value.map(rewriteFontValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewriteFontValue(child)]));
  }
  if (typeof value === 'string') return fontMap.get(value) || value;
  return value;
}

function resolveTargetSourceLayer(layer) {
  const sourceLayer = layer['source-layer'];
  const symbol = layer.type === 'symbol';
  const id = layer.id.toLowerCase();

  switch (sourceLayer) {
    case 'landcover':
      return 'landcover';
    case 'landuse_overlay':
      return id.includes('park') ? 'park' : 'landuse';
    case 'landuse':
      return 'landuse';
    case 'waterway':
      return symbol ? 'water_name' : 'waterway';
    case 'water':
      return symbol ? 'water_name' : 'water';
    case 'depth':
      return 'depth';
    case 'structure':
      return symbol ? 'transportation_name' : 'transportation';
    case 'aeroway':
      return symbol ? 'aerodrome_label' : 'aeroway';
    case 'building':
      return 'building';
    case 'road':
      return symbol ? 'transportation_name' : 'transportation';
    case 'admin':
      return 'boundary';
    case 'housenum_label':
      return 'housenumber';
    case 'place_label':
      return 'place';
    case 'motorway_junction':
      return 'transportation_name';
    case 'poi_label':
      return 'poi';
    case 'transit_stop_label':
      return 'poi';
    case 'airport_label':
      return 'aerodrome_label';
    case 'natural_label':
      if (/water|ocean|sea|lake|bay|strait|river/.test(id)) return 'water_name';
      if (/peak|mountain|volcano/.test(id)) return 'mountain_peak';
      return 'place';
    default:
      return null;
  }
}

function rewriteLayer(layer, targetSourceLayer) {
  const output = clone(layer);
  const context = { sourceLayer: layer['source-layer'], layerId: layer.id };

  output.source = 'occumed-open';
  output['source-layer'] = targetSourceLayer;
  output.metadata = {
    ...(output.metadata || {}),
    'occumed:original-source-layer': layer['source-layer'],
    'occumed:open-source-layer': targetSourceLayer
  };

  if (output.filter) output.filter = rewriteExpression(output.filter, context);
  if (output.layout) {
    output.layout = rewriteExpression(output.layout, context);
    if (output.layout['text-font']) {
      output.layout['text-font'] = rewriteFontValue(output.layout['text-font']);
    }
  }
  if (output.paint) output.paint = rewriteExpression(output.paint, context);

  return output;
}

const convertedLayers = [];
const skippedLayers = [];
const sourceLayerMappings = {};
let hillshadeInserted = false;

for (const layer of original.layers || []) {
  if (!layer.source) {
    convertedLayers.push(clone(layer));

    if (layer.type === 'background' && !convertedLayers.some((candidate) => candidate.id === 'occumed-land-surface')) {
      convertedLayers.push({
        id: 'occumed-land-surface',
        type: 'fill',
        source: 'occumed-open',
        'source-layer': 'land',
        paint: {
          'fill-color': '#E0E0D1',
          'fill-opacity': 1,
          'fill-antialias': true
        },
        metadata: {
          'occumed:purpose': 'continuous worldwide land surface from the virtual tileset'
        }
      });
    }
    continue;
  }

  const sourceLayer = layer['source-layer'];

  if (sourceLayer === 'hillshade') {
    if (!hillshadeInserted) {
      convertedLayers.push({
        id: 'occumed-hillshade',
        type: 'hillshade',
        source: 'occumed-terrain',
        minzoom: 2,
        maxzoom: 16,
        paint: {
          'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 2, 0.16, 8, 0.34, 15, 0.24],
          'hillshade-shadow-color': 'hsl(215, 18%, 30%)',
          'hillshade-highlight-color': 'hsl(48, 40%, 94%)',
          'hillshade-accent-color': 'hsl(95, 18%, 55%)',
          'hillshade-illumination-direction': 335,
          'hillshade-illumination-anchor': 'viewport'
        },
        metadata: { 'occumed:original-source-layer': 'hillshade' }
      });
      hillshadeInserted = true;
    }
    skippedLayers.push({ id: layer.id, reason: 'replaced by open raster DEM hillshade' });
    continue;
  }

  if (sourceLayer === 'contour') {
    skippedLayers.push({ id: layer.id, reason: `no equivalent ${sourceLayer} layer in the public vector schema` });
    continue;
  }

  const targetSourceLayer = resolveTargetSourceLayer(layer);
  if (!targetSourceLayer) {
    skippedLayers.push({ id: layer.id, reason: `unmapped source-layer: ${sourceLayer || 'none'}` });
    continue;
  }

  sourceLayerMappings[sourceLayer] ||= new Set();
  sourceLayerMappings[sourceLayer].add(targetSourceLayer);
  convertedLayers.push(rewriteLayer(layer, targetSourceLayer));
}

const runtimeStyle = {
  ...clone(original),
  name: 'Occu-Med Terrain — Open',
  metadata: {
    ...(original.metadata || {}),
    'occumed:visual-source': 'root style.json',
    'occumed:basemap-only': true,
    'occumed:renderer': 'MapLibre GL JS',
    'occumed:data-schema': 'OpenMapTiles'
  },
  sources: {
    'occumed-open': {
      type: 'vector',
      tiles: [vectorTilesUrl],
      minzoom: 0,
      maxzoom: 16,
      attribution:
        '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>'
    },
    'occumed-terrain': {
      type: 'raster-dem',
      tiles: [terrainUrl],
      encoding: 'terrarium',
      tileSize: 256,
      minzoom: 0,
      maxzoom: 15,
      attribution: 'Elevation data via the AWS Terrain Tiles public dataset'
    }
  },
  sprite: '__OCCUMED_PUBLIC_ORIGIN__/sprites/occumed',
  glyphs: glyphsUrl,
  projection: { type: 'globe' },
  layers: convertedLayers
};

const report = {
  generatedAt: new Date().toISOString(),
  visualSource: 'style.json',
  originalLayerCount: original.layers?.length || 0,
  runtimeLayerCount: convertedLayers.length,
  skippedLayerCount: skippedLayers.length,
  skippedLayers,
  sourceLayerMappings: Object.fromEntries(
    Object.entries(sourceLayerMappings).map(([key, values]) => [key, [...values].sort()])
  ),
  endpoints: {
    vectorTiles: vectorTilesUrl,
    glyphs: glyphsUrl,
    terrain: terrainUrl,
    relief: null,
    sprite: '__OCCUMED_PUBLIC_ORIGIN__/sprites/occumed'
  }
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(runtimeStyle, null, 2)}\n`);
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Generated ${convertedLayers.length} runtime layers from ${report.originalLayerCount} original layers; ${skippedLayers.length} incompatible layers documented.`
);
