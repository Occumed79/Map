import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = JSON.parse(await fs.readFile(path.join(root, 'style.json'), 'utf8'));
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtimeText = await fs.readFile(runtimePath, 'utf8');
const runtime = JSON.parse(runtimeText);
const report = JSON.parse(
  await fs.readFile(path.join(root, 'public/style/compatibility-report.json'), 'utf8')
);
const sprite = JSON.parse(await fs.readFile(path.join(root, 'public/sprites/occumed.json'), 'utf8'));
const sprite2x = JSON.parse(
  await fs.readFile(path.join(root, 'public/sprites/occumed@2x.json'), 'utf8')
);

const failures = [];
const fail = (message) => failures.push(message);

if (runtime.version !== 8) fail('Runtime style version must remain 8.');
if (runtime.name !== 'Occu-Med Terrain — Open') fail('Runtime style name is incorrect.');
if (runtime.projection?.type !== 'globe') fail('MapLibre globe projection is missing.');
if (runtimeText.includes('mapbox://')) fail('Runtime style still contains a mapbox:// endpoint.');
if (runtimeText.includes('api.mapbox.com')) fail('Runtime style still contains a Mapbox API endpoint.');
if (!runtime.glyphs?.startsWith('https://fonts.openmaptiles.org/')) {
  fail('Runtime glyph endpoint is not the no-key concatenated OpenMapTiles endpoint.');
}
if (runtime.glyphs?.includes('tiles.openfreemap.org/fonts')) {
  fail('Runtime still uses the glyph endpoint that rejects combined font stacks.');
}
if (!String(runtime.sprite).includes('/sprites/occumed')) fail('Local Occu-Med sprite endpoint is missing.');

const allowedSources = new Set(['occumed-open', 'occumed-terrain', 'occumed-relief']);
for (const sourceName of Object.keys(runtime.sources || {})) {
  if (!allowedSources.has(sourceName)) fail(`Unexpected shared source: ${sourceName}`);
}

const requiredSourceLayers = new Set([
  'landcover',
  'landuse',
  'waterway',
  'water',
  'aeroway',
  'building',
  'transportation',
  'transportation_name',
  'boundary',
  'place',
  'poi'
]);
const runtimeSourceLayers = new Set(
  runtime.layers.map((layer) => layer['source-layer']).filter(Boolean)
);
for (const sourceLayer of requiredSourceLayers) {
  if (!runtimeSourceLayers.has(sourceLayer)) fail(`Missing mapped source-layer: ${sourceLayer}`);
}

const minimumLayerCount = Math.max(100, Math.floor(original.layers.length * 0.7));
if (runtime.layers.length < minimumLayerCount) {
  fail(`Runtime style is too incomplete: ${runtime.layers.length} layers; expected at least ${minimumLayerCount}.`);
}
if (!runtime.layers.some((layer) => layer.id === 'occumed-hillshade')) fail('Open hillshade layer is missing.');
if (!runtime.layers.some((layer) => layer.id === 'occumed-shaded-relief')) fail('Low-zoom relief layer is missing.');
if (runtime.layers.filter((layer) => layer.type === 'symbol').length < 20) {
  fail('Too few label and symbol layers survived the conversion.');
}

const runtimeOriginalIds = runtime.layers
  .filter((layer) => !layer.id.startsWith('occumed-'))
  .map((layer) => layer.id);
const originalIndex = new Map(original.layers.map((layer, index) => [layer.id, index]));
let lastIndex = -1;
for (const id of runtimeOriginalIds) {
  const index = originalIndex.get(id);
  if (index === undefined) fail(`Runtime introduced an unknown visual layer: ${id}`);
  if (index < lastIndex) fail(`Original layer ordering was changed near ${id}.`);
  lastIndex = index;
}

const spriteCount = Object.keys(sprite).length;
const sprite2xCount = Object.keys(sprite2x).length;
if (spriteCount < 100) fail(`Compiled sprite is incomplete: ${spriteCount} icons.`);
if (spriteCount !== sprite2xCount) fail('1x and 2x sprite manifests do not contain the same icon IDs.');

function collectStrings(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) {
    for (const child of value) collectStrings(child, result);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, result);
  }
  return result;
}

const activeFontStrings = runtime.layers.flatMap((layer) =>
  collectStrings(layer.layout?.['text-font'])
);
const unavailableFonts = [...new Set(
  activeFontStrings.filter(
    (font) => font.includes('DIN Pro') || font.includes('Arial Unicode MS')
  )
)];
if (unavailableFonts.length) {
  fail(`Rendered layers still request unavailable font stacks: ${unavailableFonts.join(', ')}`);
}

if (report.originalLayerCount !== original.layers.length) fail('Compatibility report source count is stale.');
if (report.runtimeLayerCount !== runtime.layers.length) fail('Compatibility report runtime count is stale.');

if (failures.length) {
  console.error('Occu-Med open basemap validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Open basemap validated: ${runtime.layers.length}/${original.layers.length} visual layers, ${runtime.layers.filter((layer) => layer.type === 'symbol').length} symbol layers, ${activeFontStrings.length} active font references, and ${spriteCount} sprite images.`
);
