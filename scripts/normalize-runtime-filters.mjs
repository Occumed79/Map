import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

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
    'motorway', 'motorway',
    'trunk', 'trunk',
    'primary', 'primary',
    'secondary', 'secondary',
    'tertiary', 'tertiary',
    'minor', 'street',
    'service', 'service',
    'track', 'track',
    'path', 'path',
    'pedestrian', 'path',
    'steps', 'path',
    'raceway', 'street',
    'rail', 'major_rail',
    'transit', 'transit',
    'ferry', 'ferry',
    'cable_car', 'aerialway',
    'gondola', 'aerialway',
    'street'
  ]
];

const landcoverClassExpression = [
  'match',
  get('class'),
  'farmland', 'crop',
  'ice', 'snow',
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
  if (key === '$type') return ['geometry-type'];
  if (key === '$id') return ['id'];
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
  if (key === '$type' || key === '$id') return true;
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

function normalizeFilter(node, context) {
  if (!Array.isArray(node) || typeof node[0] !== 'string') return node;

  const [operator, ...args] = node;

  if (operator === 'all' || operator === 'any') {
    return [operator, ...args.map((child) => normalizeFilter(child, context))];
  }

  if (operator === 'none') {
    return ['!', ['any', ...args.map((child) => normalizeFilter(child, context))]];
  }

  if (operator === 'has' || operator === '!has') {
    if (typeof args[0] === 'string' && args.length === 1) {
      const expression = translatedHas(args[0]);
      return operator === 'has' ? expression : ['!', expression];
    }
    return node;
  }

  if (operator === 'in' || operator === '!in') {
    if (typeof args[0] === 'string' && args.length >= 2) {
      const labels = args.slice(1);
      const expression = [
        'match',
        translatedGet(args[0], context),
        labels.length === 1 ? labels[0] : labels,
        true,
        false
      ];
      return operator === 'in' ? expression : ['!', expression];
    }
    return node;
  }

  if (['==', '!=', '>', '>=', '<', '<='].includes(operator)) {
    if (typeof args[0] === 'string' && args.length >= 2) {
      return [operator, translatedGet(args[0], context), args[1], ...args.slice(2)];
    }
    return node;
  }

  return node;
}

let changedLayers = 0;
for (const layer of runtime.layers || []) {
  if (!layer.filter) continue;

  const context = {
    sourceLayer: layer.metadata?.['occumed:original-source-layer'] || layer['source-layer'],
    layerId: layer.id
  };

  const before = JSON.stringify(layer.filter);
  layer.filter = normalizeFilter(layer.filter, context);
  if (JSON.stringify(layer.filter) !== before) changedLayers += 1;
}

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(`Normalized mixed legacy/expression filters in ${changedLayers} runtime layers.`);
