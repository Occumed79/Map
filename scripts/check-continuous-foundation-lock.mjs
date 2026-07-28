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
  workflow
] = await Promise.all([
  fs.readFile(path.join(root, 'scripts/prepare-world-landcover.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-surface.sh'), 'utf8'),
  fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8'),
  fs.readFile(path.join(root, 'src/styles.css'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/capture-polygon-regression.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/validate-continuous-zoom.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/validate-all-zoom-levels.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/check-world-soak.mjs'), 'utf8'),
  fs.readFile(path.join(root, '.github/workflows/validate-continuous-zoom.yml'), 'utf8')
]);

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

for (const marker of [
  'installOccumedAtmosphereBloom(map)',
  'resolveGlobeRadius',
  'BLOOM_FADE_START_ZOOM',
  'BLOOM_FADE_END_ZOOM'
]) {
  assert(mapHelper.includes(marker), `Atmosphere tracking lost ${marker}.`);
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
  'Continuous-foundation lock passed: landcover through zoom 10, overscaling through zoom 16, strengthened tracked atmosphere, exhaustive boundary checks, and sustained worldwide soak are mandatory.'
);
