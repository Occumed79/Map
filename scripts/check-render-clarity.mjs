import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [helper, spriteBuilder, runtime] = await Promise.all([
  fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-sprites.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8').then(JSON.parse)
]);

const failures = [];
const fail = (message) => failures.push(message);
const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);

if (!helper.includes('const MIN_RENDER_PIXEL_RATIO = 2;')) {
  fail('The map no longer guarantees at least a 2x render canvas.');
}
if (!helper.includes('const MAX_RENDER_PIXEL_RATIO = 3;')) {
  fail('The high-DPI canvas no longer has the approved 3x safety ceiling.');
}
if (!helper.includes('pixelRatio: resolveOccumedPixelRatio()')) {
  fail('The MapLibre canvas is not using the explicit high-DPI pixel-ratio policy.');
}
if (!helper.includes('antialias: true')) {
  fail('MapLibre antialiasing is disabled.');
}
if (!spriteBuilder.includes("await writeSprite(images, 2, '@2x');")) {
  fail('The high-DPI @2x sprite sheet is no longer generated.');
}

const source = runtime.sources?.['occumed-open'];
if (source?.type !== 'vector') {
  fail('Primary roads, labels, boundaries, and buildings are not backed by vector tiles.');
}

const requiredVectorLayers = [
  'road-motorway-trunk',
  'road-primary',
  'road-secondary-tertiary',
  'road-street-low',
  'building',
  'admin-0-boundary',
  'admin-1-boundary',
  'country-label',
  'state-label',
  'settlement-major-label',
  'settlement-minor-label'
];
for (const id of requiredVectorLayers) {
  const candidate = layer(id);
  if (!candidate) {
    fail(`Required sharp vector layer is missing: ${id}`);
    continue;
  }
  if (candidate.type === 'raster' || candidate.source !== 'occumed-open') {
    fail(`${id} is not rendered from the shared vector source.`);
  }
}

const rasterLayers = runtime.layers.filter((candidate) => candidate.type === 'raster');
if (rasterLayers.length) {
  fail('A raster basemap layer can soften or replace the continuous vector map.');
}

if (runtime.metadata?.['occumed:high-dpi-vector-clarity'] !== true) {
  fail('High-DPI vector-clarity metadata is missing.');
}

if (failures.length) {
  console.error('Occu-Med render clarity validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Render clarity validated: 2x–3x canvas, antialiasing, @2x sprites, and vector-only basemap detail.');
