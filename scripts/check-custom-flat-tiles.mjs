import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const style = JSON.parse(await fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8'));
const mapSource = await fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8');
const main = await fs.readFile(path.join(root, 'src/main.js'), 'utf8');
const server = await fs.readFile(path.join(root, 'server.mjs'), 'utf8');
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };
const sources = Object.entries(style.sources || {});
const source = style.sources?.['occumed-open'];

expect(style.projection?.type === 'mercator', 'Projection is not flat Mercator.');
expect(sources.length === 1, `Expected one browser source; found ${sources.length}.`);
expect(source?.type === 'vector', 'occumed-open is not a vector source.');
expect(JSON.stringify(source?.tiles) === JSON.stringify(['__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf']), 'Custom source does not use the immutable tile endpoint.');
expect(source?.minzoom === 0 && source?.maxzoom === 16, 'Custom source does not cover z0-z16.');
expect(!style.sky && !style.fog && !style.terrain && !style.light, 'Globe, fog, terrain, or lighting remains active.');
expect(!(style.layers || []).some((layer) => ['sky', 'hillshade', 'model'].includes(layer.type)), 'Forbidden globe/terrain layers remain.');
expect((style.layers || []).every((layer) => !layer.source || layer.source === 'occumed-open'), 'A layer references a second browser source.');
expect(style.metadata?.['occumed:architecture'] === 'immutable-custom-flat-pmtiles', 'Custom flat architecture metadata is missing.');
expect(style.metadata?.['occumed:exact-prebuilt-addressing'] === true, 'Exact addressing metadata is missing.');
expect(main.includes("./occumed-map.js"), 'Application is not using the preserved custom map renderer.');
expect(!main.includes('new-map-v2'), 'Generic basemap renderer is still active.');
expect(!mapSource.includes('installOccumedAtmosphereBloom(map);'), 'Globe atmosphere is still installed.');
expect(mapSource.includes('installExactTileAddressing(map);'), 'Exact prebuilt tile addressing is not installed.');
expect(server.includes('ImmutableWorldTileset'), 'Production server is not using the immutable PMTiles store.');
expect(!server.includes('NAV_DATABASE_URL_'), 'Production server still references Neon tile cache variables.');

const sourceLayers = new Set((style.layers || []).map((layer) => layer['source-layer']).filter(Boolean));
for (const layer of ['land', 'landcover', 'depth', 'water', 'transportation', 'boundary', 'place']) {
  expect(sourceLayers.has(layer), `Generated style is missing required ${layer} layer usage.`);
}

if (failures.length) {
  console.error('Custom flat PMTiles contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Custom flat PMTiles contract passed: one immutable z0-z16 source, Mercator, no runtime merge, no Neon, exact prebuilt addressing.');
