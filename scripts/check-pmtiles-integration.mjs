import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [pkg, helper, sourcePass, profile] = await Promise.all([
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/use-custom-pmtiles-source.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'planetiler/occumed-basemap.yml'), 'utf8')
]);

const failures = [];
const fail = (message) => failures.push(message);

if (pkg.dependencies?.pmtiles !== '4.4.1') fail('The PMTiles browser dependency is missing or unpinned.');
if (!helper.includes("import { Protocol } from 'pmtiles';")) fail('The PMTiles protocol import is missing.');
if (!helper.includes("maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile)")) fail('MapLibre does not register the PMTiles protocol.');
if (!helper.includes("source.url.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', styleOrigin)")) fail('PMTiles source URLs are not resolved against the deployed origin.');
if (!sourcePass.includes('OCCUMED_PMTILES_URL')) fail('The runtime style cannot be pointed at a custom PMTiles archive.');
if (!sourcePass.includes("'occumed:vector-source-mode': 'custom-planetiler-pmtiles'")) fail('Custom PMTiles source metadata is missing.');

for (const requiredLayer of [
  'landcover', 'landuse', 'park', 'water', 'waterway', 'transportation',
  'transportation_name', 'building', 'aeroway', 'boundary', 'place', 'poi',
  'water_name', 'mountain_peak', 'housenumber'
]) {
  if (!profile.includes(`- id: ${requiredLayer}`)) fail(`Planetiler profile is missing layer: ${requiredLayer}`);
}

for (const requiredAttribute of ['class', 'subclass', 'brunnel', 'ramp', 'ref', 'rank', 'admin_level', 'disputed']) {
  if (!profile.includes(`key: ${requiredAttribute}`)) fail(`Planetiler profile is missing normalized attribute: ${requiredAttribute}`);
}

if (failures.length) {
  console.error('PMTiles integration validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('PMTiles integration validated: protocol registration, source switching, and Occu-Med Planetiler schema are present.');
