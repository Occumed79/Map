import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [
  pkg,
  helper,
  styleBuilder,
  sourceProfile,
  manifestBuilder,
  overviewBuilder,
  gateway,
  server,
  workflow,
  readme
] = await Promise.all([
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-runtime-style.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'planetiler/occumed-basemap.yml'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-manifest.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-overview.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/server/world-tile-gateway.js'), 'utf8'),
  fs.readFile(path.join(root, 'server.mjs'), 'utf8'),
  fs.readFile(path.join(root, '.github/workflows/build-virtual-world-tileset.yml'), 'utf8'),
  fs.readFile(path.join(root, 'README.md'), 'utf8')
]);

const failures = [];
const fail = (message) => failures.push(message);

for (const [dependency, version] of Object.entries({
  pmtiles: '4.4.1',
  '@mapbox/vector-tile': '2.0.4',
  pbf: '4.0.1',
  'vt-pbf': '3.1.3'
})) {
  if (pkg.dependencies?.[dependency] !== version) {
    fail(`The pinned ${dependency} dependency is missing.`);
  }
}

if (!styleBuilder.includes("'__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf'")) {
  fail('The runtime style is not generated with the permanent virtual tile URL.');
}
if (styleBuilder.toLowerCase().includes('openfreemap')) {
  fail('The runtime style builder still configures OpenFreeMap.');
}
if (helper.includes('Protocol') || helper.includes('setUrl(') || helper.includes('world-pmtiles-router')) {
  fail('The browser helper still contains PMTiles shard routing.');
}
if (!helper.includes('fadeDuration: 0')) fail('The browser can crossfade stale basemap tiles.');
if (!helper.includes("source.tiles = source.tiles.map")) {
  fail('Permanent vector tile templates are not resolved to the style origin.');
}

if (!server.includes("const tileMatch = /^\\/tiles\\/(\\d+)\\/(\\d+)\\/(\\d+)\\.pbf$/")) {
  fail('The server is missing the single virtual Z/X/Y endpoint.');
}
if (server.includes('/world-tiles/')) fail('The server still publishes browser-visible regional archive paths.');
if (!gateway.includes('regionsForTile(zoom, x, y)')) fail('The gateway does not route each requested tile by bounds.');
if (!gateway.includes('Promise.all')) fail('The gateway cannot resolve intersecting archives together.');
if (!gateway.includes('mergeVectorTiles')) fail('The gateway cannot merge MVT layers at shard boundaries.');
if (!gateway.includes('MemoryTileCache')) fail('Resolved worldwide tiles are not cached.');
if (!gateway.includes('overscaleVectorLayer')) fail('The land surface cannot remain continuous above its generalized zoom.');

if (!overviewBuilder.includes('mergeVectorTiles(payloads)')) {
  fail('The low-zoom overview is not consolidated from the regional archives.');
}
if (!manifestBuilder.includes('version: 2')) fail('The server-only routing manifest is not version 2.');
if (!manifestBuilder.includes('overviewAsset')) fail('The manifest does not declare the consolidated overview archive.');
if (!manifestBuilder.includes('surfaceAsset')) fail('The manifest does not declare the worldwide land surface.');
if (manifestBuilder.includes('switchZoom')) fail('The obsolete browser switch zoom remains in the manifest.');
if (manifestBuilder.includes('archiveProxyTemplate')) fail('The manifest still advertises regional archives to browsers.');

for (const marker of [
  'Build consolidated zoom 0-5 overview',
  'Build worldwide land surface',
  'Publish virtual storage archives',
  'Publish server-only routing manifest',
  'occumed-world-overview.pmtiles',
  'occumed-world-surface.pmtiles'
]) {
  if (!workflow.includes(marker)) fail(`Virtual tileset workflow is missing: ${marker}`);
}

for (const requiredLayer of [
  'landcover', 'landuse', 'park', 'water', 'waterway', 'transportation',
  'transportation_name', 'building', 'aeroway', 'aerodrome_label', 'boundary',
  'place', 'poi', 'water_name', 'mountain_peak', 'housenumber'
]) {
  if (!sourceProfile.includes(`- id: ${requiredLayer}`)) {
    fail(`Regional source profile is missing layer: ${requiredLayer}`);
  }
}

if (!readme.includes('/tiles/{z}/{x}/{y}.pbf')) {
  fail('The documented integration does not describe the one permanent tile source.');
}
if (readme.includes('regional source routing') || readme.includes('global open-vector fallback')) {
  fail('The documentation still describes two-map routing.');
}

if (failures.length) {
  console.error('Virtual PMTiles integration validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('PMTiles storage integration validated behind one permanent worldwide vector endpoint.');
