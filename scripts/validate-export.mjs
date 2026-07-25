import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylePath = path.join(root, 'style.json');
const licensePath = path.join(root, 'license.txt');

const EXPECTED_STYLE_GIT_BLOB = '8c2dd7395d74c95ef19df7b668198a74124fb7e0';
const EXPECTED_LICENSE_GIT_BLOB = '704e4a07e0da5a6da8604d202343f015334e2acb';

function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

const [styleBuffer, licenseBuffer] = await Promise.all([
  fs.readFile(stylePath),
  fs.readFile(licensePath)
]);

const failures = [];
const styleSha = gitBlobSha(styleBuffer);
const licenseSha = gitBlobSha(licenseBuffer);

if (styleSha !== EXPECTED_STYLE_GIT_BLOB) {
  failures.push(`style.json changed (${styleSha}); expected untouched export ${EXPECTED_STYLE_GIT_BLOB}.`);
}

if (licenseSha !== EXPECTED_LICENSE_GIT_BLOB) {
  failures.push(`license.txt changed (${licenseSha}); expected ${EXPECTED_LICENSE_GIT_BLOB}.`);
}

let style;
try {
  style = JSON.parse(styleBuffer.toString('utf8'));
} catch (error) {
  failures.push(`style.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

if (style) {
  if (style.version !== 8) failures.push('The exported style version must remain 8.');
  if (style.name !== 'Occu-Med Terrain') failures.push('The exported style name must remain Occu-Med Terrain.');
  if (!Array.isArray(style.layers) || style.layers.length < 100) {
    failures.push(`The export appears incomplete; found ${style.layers?.length ?? 0} layers.`);
  }

  const sourceUrl = style.sources?.composite?.url;
  const expectedSource =
    'mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2,mapbox.mapbox-bathymetry-v2';
  if (sourceUrl !== expectedSource) failures.push('The original composite Mapbox source declaration changed.');

  if (style.glyphs !== 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf') {
    failures.push('The original Mapbox glyph declaration changed.');
  }

  if (!String(style.sprite || '').startsWith('mapbox://sprites/alexayvazian999/')) {
    failures.push('The original Mapbox sprite declaration changed.');
  }

  const requiredLayerIds = ['land', 'landcover', 'water', 'hillshade', 'contour-line', 'building'];
  const layerIds = new Set(style.layers?.map((layer) => layer.id));
  for (const id of requiredLayerIds) {
    if (!layerIds.has(id)) failures.push(`Required exported layer is missing: ${id}.`);
  }
}

if (failures.length) {
  console.error('Exact export validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Exact export validated: ${style.layers.length} untouched layers, license preserved.`);
