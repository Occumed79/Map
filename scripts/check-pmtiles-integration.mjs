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
  mvt,
  retryingSource,
  tileSafety,
  server,
  workflow,
  surfaceBuilder,
  readme
] = await Promise.all([
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-runtime-style.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'planetiler/occumed-basemap.yml'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-manifest.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-overview.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/server/world-tile-gateway.js'), 'utf8'),
  fs.readFile(path.join(root, 'src/server/mvt.js'), 'utf8'),
  fs.readFile(path.join(root, 'src/server/pmtiles-source.js'), 'utf8'),
  fs.readFile(path.join(root, 'src/server/tile-safety.js'), 'utf8'),
  fs.readFile(path.join(root, 'server.mjs'), 'utf8'),
  fs.readFile(path.join(root, '.github/workflows/build-virtual-world-tileset.yml'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-surface.sh'), 'utf8'),
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
if (!helper.includes('cancelPendingTileRequestsWhileZooming: false')) {
  fail('The browser can cancel still-loading parent tiles during zoom.');
}
if (
  !helper.includes('const WORLD_ZOOM_PYRAMID_LEVELS = WORLD_MAX_ZOOM - WORLD_MIN_ZOOM + 1') ||
  !helper.includes('maxTileCacheZoomLevels: WORLD_ZOOM_PYRAMID_LEVELS')
) {
  fail('The browser does not retain the complete 0-16 parent zoom pyramid for reverse navigation.');
}
if (!helper.includes('refreshExpiredTiles: false')) {
  fail('The browser can replace visible tiles through in-session expiry refreshes.');
}
if (!helper.includes('fadeDuration: 300')) {
  fail('Normal symbol collision fading is not enabled during zoom.');
}
if (!helper.includes('source.tiles = source.tiles.map')) {
  fail('Permanent vector tile templates are not resolved to the style origin.');
}

if (!server.includes('const tileMatch =') || !server.includes('await serveVirtualTile(request, response, coordinates)')) {
  fail('The server is missing the single virtual Z/X/Y route contract.');
}
if (server.includes('/world-tiles/')) fail('The server still publishes browser-visible regional archive paths.');
if (!gateway.includes('regionsForTile(zoom, x, y)')) fail('The gateway does not route each requested tile by bounds.');
if (!gateway.includes('Promise.allSettled')) fail('The gateway does not fail closed when one required shard read fails.');
if (!gateway.includes('mergeVectorTiles')) fail('The gateway cannot merge MVT layers at shard boundaries.');
if (!gateway.includes('MemoryTileCache')) fail('Resolved worldwide tiles are not cached.');
if (!gateway.includes('getStale')) fail('The gateway cannot serve a last-known-good tile during an upstream outage.');
if (!gateway.includes('overscaleVectorLayer')) fail('The physical surface cannot remain continuous above its generalized zoom.');
if (!gateway.includes("const CONTINUOUS_SURFACE_LAYERS = Object.freeze(['land', 'landcover', 'depth'])")) {
  fail('The gateway does not define one authoritative land/landcover/depth foundation.');
}
if (!gateway.includes('includeLayers: CONTINUOUS_SURFACE_LAYERS')) {
  fail('The gateway does not retain the complete physical surface.');
}
if (!gateway.includes('excludeLayers: CONTINUOUS_SURFACE_LAYERS')) {
  fail('Overview or regional archives can still replace the physical foundation.');
}
if (!gateway.includes('CONTINUOUS_SURFACE_LAYERS.map')) {
  fail('All physical surface layers are not overscaled through maximum zoom.');
}
if (!gateway.includes('maxInflightTiles') || !gateway.includes('maxTileFanout')) {
  fail('The gateway lacks bounded in-flight work or shard fan-out limits.');
}
if (!gateway.includes('manifestStaleMs') || !gateway.includes('maxManifestBytes')) {
  fail('The gateway lacks last-known-good manifest recovery or manifest size limits.');
}
if (!retryingSource.includes('OCCUMED_UPSTREAM_CIRCUIT_OPEN')) {
  fail('PMTiles byte-range reads are not protected by a circuit breaker.');
}
if (!retryingSource.includes('maxRangeBytes') || !retryingSource.includes('isRetryableUpstreamError')) {
  fail('PMTiles byte-range reads lack size limits or retry classification.');
}
if (!tileSafety.includes('validateVectorTilePayload') || !tileSafety.includes('maxTotalPoints')) {
  fail('Vector tiles are not protected by decode and geometry budgets.');
}
if (!mvt.includes("import { validateVectorTilePayload } from './tile-safety.js'")) {
  fail('MVT merge and overscale operations bypass the safety validator.');
}
if (!mvt.includes('MVT merge input') || !mvt.includes('MVT overscale input')) {
  fail('Upstream MVT payloads are not validated before merge and overscale processing.');
}
if (!mvt.includes('merged MVT output') || !mvt.includes('overscaled MVT output')) {
  fail('Encoded MVT outputs are not revalidated before delivery or caching.');
}
if (!server.includes('gzipAsync')) fail('Tile compression still blocks the Node event loop.');
if (!server.includes("url.pathname === '/readyz'")) fail('The production server lacks a readiness endpoint.');
if (!server.includes('maxConcurrentTileRequests')) fail('The HTTP tile endpoint lacks a concurrency limit.');
if (!server.includes('stale-if-error=86400')) fail('Tile responses lack bounded stale-if-error protection.');
if (!server.includes('graceful') && !server.includes('draining connections')) {
  fail('The production server lacks graceful shutdown handling.');
}
if (!server.includes('OCCUMED_WORLD_SURFACE_URL')) {
  fail('Read-only visual validation cannot serve its candidate physical surface.');
}

if (!overviewBuilder.includes('mergeVectorTiles(payloads)')) {
  fail('The low-zoom overview is not consolidated from the regional archives.');
}
if (!manifestBuilder.includes('version: 2')) fail('The server-only routing manifest is not version 2.');
if (!manifestBuilder.includes('overviewAsset')) fail('The manifest does not declare the consolidated overview archive.');
if (!manifestBuilder.includes('surfaceAsset')) fail('The manifest does not declare the worldwide physical surface.');
if (!manifestBuilder.includes("surfaceLayers: ['land', 'landcover', 'depth']")) {
  fail('The manifest does not document the physical surface archive schema.');
}
if (manifestBuilder.includes('switchZoom')) fail('The obsolete browser switch zoom remains in the manifest.');
if (manifestBuilder.includes('archiveProxyTemplate')) fail('The manifest still advertises regional archives to browsers.');

for (const marker of [
  'Build consolidated zoom 0-5 overview',
  'Build worldwide physical surface',
  'Build candidate worldwide physical surface',
  'prepare-world-bathymetry.mjs',
  'ne_10m_bathymetry_${band}.geojson',
  'Publish virtual storage archives',
  'Publish server-only routing manifest',
  'occumed-world-overview.pmtiles',
  'occumed-world-surface.pmtiles'
]) {
  if (!`${workflow}\n${surfaceBuilder}`.includes(marker)) {
    fail(`Virtual tileset workflow is missing: ${marker}`);
  }
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
if (pkg.scripts?.['check:hardening'] !== 'node scripts/check-world-hardening.mjs') {
  fail('The chaos hardening suite is not part of the repository scripts.');
}

if (failures.length) {
  console.error('Virtual PMTiles integration validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('PMTiles storage integration validated behind one permanent worldwide vector endpoint with a continuous physical foundation, complete browser parent-pyramid retention, pre-merge and post-encode MVT budgets, bounded upstream work, circuit breaking, stale recovery, and hardened HTTP delivery.');
