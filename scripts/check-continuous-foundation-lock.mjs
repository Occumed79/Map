import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [
  landcoverBuilder,
  surfaceBuilder,
  mapHelper,
  appCss,
  polygonGate,
  motionGate,
  allZoomGate,
  soakGate,
  workflow,
  packageDocument,
  renderingContract,
  runtimeStyleDocument
] = await Promise.all([
  fs.readFile(path.join(root, 'scripts/prepare-world-landcover.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-surface.sh'), 'utf8'),
  fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8'),
  fs.readFile(path.join(root, 'src/styles.css'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/capture-polygon-regression.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/validate-continuous-zoom.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/validate-all-zoom-levels.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/check-world-soak.mjs'), 'utf8'),
  fs.readFile(path.join(root, '.github/workflows/validate-continuous-zoom.yml'), 'utf8'),
  fs.readFile(path.join(root, 'package.json'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/apply-mapbox-rendering-contract.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8')
]);

const packageJson = JSON.parse(packageDocument);
const runtimeStyle = JSON.parse(runtimeStyleDocument);

assert(
  landcoverBuilder.includes('const SURFACE_MAX_ZOOM = 10;'),
  'Worldwide landcover is not locked to the physical surface native maximum zoom.'
);
assert(
  !/maxzoom\s*:\s*5\b/.test(landcoverBuilder),
  'The old zoom-5 landcover cutoff was reintroduced.'
);
assert(
  landcoverBuilder.includes('maxzoom: SURFACE_MAX_ZOOM'),
  'Worldwide landcover no longer carries an explicit continuous maximum zoom.'
);
assert(
  surfaceBuilder.includes('--maximum-zoom=10') &&
    surfaceBuilder.includes('-L "landcover:'),
  'The physical surface build no longer publishes landcover through zoom 10.'
);

const prepareStyle = packageJson.scripts?.['prepare:style'] || '';
const contractIndex = prepareStyle.indexOf('apply-mapbox-rendering-contract.mjs');
const restoreIndex = prepareStyle.indexOf('restore-exported-cartography.mjs');
const atmosphereIndex = prepareStyle.indexOf('lock-reference-atmosphere.mjs');
assert(contractIndex > restoreIndex && contractIndex > atmosphereIndex,
  'The documented rendering contract must run after all style restoration and atmosphere passes.');

for (const marker of [
  'source.minzoom = 0',
  'source.maxzoom = 16',
  "delete layer.maxzoom",
  'runtime.transition = { duration: 0, delay: 0 }',
  "layer.paint['fill-opacity'] = ['max', 0.06, existingOpacity]"
]) {
  assert(renderingContract.includes(marker), `The documented rendering contract lost ${marker}.`);
}

const permanentSources = Object.values(runtimeStyle.sources || {}).filter((source) =>
  source?.type === 'vector' &&
  Array.isArray(source.tiles) &&
  source.tiles.some((url) => String(url).includes('/tiles/{z}/{x}/{y}.pbf'))
);
assert.equal(permanentSources.length, 1, 'The runtime must expose exactly one permanent worldwide vector source.');
assert.equal(permanentSources[0].minzoom, 0, 'The permanent worldwide vector source must begin at zoom 0.');
assert.equal(permanentSources[0].maxzoom, 16, 'The permanent worldwide vector source must cover through zoom 16.');
assert.deepEqual(runtimeStyle.transition, { duration: 0, delay: 0 },
  'The runtime style must not delay foundation paint updates.');

const foundationLayers = (runtimeStyle.layers || []).filter((layer) =>
  ['land', 'landcover', 'depth'].includes(String(layer['source-layer'] || layer.metadata?.['occumed:open-source-layer'] || '').toLowerCase())
);
assert(foundationLayers.length > 0, 'The runtime style has no physical foundation layers.');
for (const layer of foundationLayers) {
  assert.equal(layer.minzoom, 0, `${layer.id} must begin at zoom 0.`);
  assert(!Object.hasOwn(layer, 'maxzoom'), `${layer.id} must not have a style-layer maxzoom cutoff.`);
  assert.equal(layer.layout?.visibility, 'visible', `${layer.id} must remain visible.`);
}

const landcoverLayers = foundationLayers.filter((layer) =>
  String(layer['source-layer'] || layer.metadata?.['occumed:open-source-layer'] || '').toLowerCase() === 'landcover' &&
  layer.type === 'fill'
);
assert(landcoverLayers.length > 0, 'The runtime has no rendered landcover foundation.');
for (const layer of landcoverLayers) {
  assert.deepEqual(layer.paint?.['fill-opacity'], [
    'interpolate', ['linear'], ['zoom'],
    0, 0.92,
    6, 0.88,
    10, 0.82,
    16, 0.82
  ], `${layer.id} landcover opacity must remain nonzero through zoom 16.`);
}

const depthLayers = foundationLayers.filter((layer) =>
  String(layer['source-layer'] || layer.metadata?.['occumed:open-source-layer'] || '').toLowerCase() === 'depth' &&
  layer.type === 'fill'
);
assert(depthLayers.length > 0, 'The runtime has no rendered depth foundation.');
for (const layer of depthLayers) {
  const opacity = layer.paint?.['fill-opacity'];
  assert(Array.isArray(opacity) && opacity[0] === 'max' && opacity[1] >= 0.06,
    `${layer.id} bathymetry opacity can still collapse to zero.`);
}

for (const marker of [
  'installOccumedAtmosphereBloom(map)',
  'resolveGlobeRadius',
  'BLOOM_FADE_START_ZOOM',
  'BLOOM_FADE_END_ZOOM',
  'cancelPendingTileRequestsWhileZooming: false',
  'const WORLD_ZOOM_PYRAMID_LEVELS = WORLD_MAX_ZOOM - WORLD_MIN_ZOOM + 1',
  'maxTileCacheZoomLevels: WORLD_ZOOM_PYRAMID_LEVELS'
]) {
  assert(mapHelper.includes(marker), `MapLibre continuity behavior lost ${marker}.`);
}
for (const marker of [
  'scale(1.006)',
  '0 0 84px 24px',
  'drop-shadow(0 0 30px',
  'mix-blend-mode: screen',
  'border: 1px solid'
]) {
  assert(appCss.includes(marker), `The exterior atmosphere bloom lost ${marker}.`);
}

for (const marker of ['5.9', '6, 6.1', '15, 16', "requiredSourceLayers: ['land', 'landcover']", "requiredSourceLayers: ['depth']"]) {
  assert(polygonGate.includes(marker), `The exhaustive polygon/foundation gate lost ${marker}.`);
}
for (const marker of [
  'amazon-routing-threshold-in',
  'amazon-routing-threshold-out',
  'pacific-routing-threshold-in',
  'antimeridian-pan',
  'missingFoundationSampleCount'
]) {
  assert(motionGate.includes(marker), `The continuous motion gate lost ${marker}.`);
}
for (const marker of [
  'amazon-all-zooms-in',
  'amazon-all-zooms-out',
  'pacific-all-zooms-in',
  'pacific-all-zooms-out',
  'antimeridian-all-zooms-out',
  'startZoom: 0, endZoom: 16',
  'startZoom: 16, endZoom: 0'
]) {
  assert(allZoomGate.includes(marker), `The complete zoom 0–16 gate lost ${marker}.`);
}

for (const marker of [
  'const waves = 3',
  'const concurrency = 24',
  'zooms = [0, 2, 4, 5, 6, 7, 8, 10, 12, 14, 16]',
  'after.inflightTiles, 0',
  'after.archiveReads.active, 0',
  'after.archiveReads.queued, 0',
  'source.circuitOpen, false'
]) {
  assert(soakGate.includes(marker), `The worldwide soak gate lost ${marker}.`);
}
assert(workflow.includes('run_gate world-soak'), 'The sustained worldwide soak is no longer mandatory in CI.');
assert(workflow.includes('continuous-motion/*.json'), 'Runtime JSON diagnostics are no longer preserved.');
assert(workflow.includes('gate-status.txt'), 'Aggregate runtime gate status is no longer preserved.');

console.log(
  'Continuous-foundation lock passed: documented source/layer zoom semantics, nonzero landcover and depth through zoom 16, full 0–16 parent-tile retention, strengthened atmosphere, exhaustive boundary checks, and sustained worldwide soak are mandatory.'
);
