import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylePath = path.join(root, 'public/style/occumed-open.json');
const style = JSON.parse(await fs.readFile(stylePath, 'utf8'));
const sources = Object.entries(style.sources || {});

if (sources.length !== 1 || sources[0][0] !== 'occumed-open' || sources[0][1]?.type !== 'vector') {
  throw new Error(`Custom flat map requires exactly one occumed-open vector source; found ${sources.length}.`);
}

style.projection = { type: 'mercator' };
delete style.sky;
delete style.fog;
delete style.terrain;
delete style.light;
style.layers = (style.layers || []).filter((layer) => !['sky', 'hillshade', 'model'].includes(layer.type));

for (const layer of style.layers) {
  if (layer.type === 'background') {
    layer.paint = { ...(layer.paint || {}), 'background-color': '#79BCEC', 'background-opacity': 1 };
  }
}

style.metadata = {
  ...(style.metadata || {}),
  'occumed:architecture': 'immutable-custom-flat-pmtiles',
  'occumed:projection': 'mercator',
  'occumed:source-count': 1,
  'occumed:globe': false,
  'occumed:runtime-merge': false,
  'occumed:regional-routing': false,
  'occumed:neon': false,
  'occumed:exact-prebuilt-addressing': true
};

await fs.writeFile(stylePath, `${JSON.stringify(style, null, 2)}\n`);
console.log('Locked the preserved Occu-Med custom tileset to flat Mercator.');
