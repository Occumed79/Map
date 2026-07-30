#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylePath = path.join(root, 'public', 'style', 'occumed-open.json');
const style = JSON.parse(await fs.readFile(stylePath, 'utf8'));
const source = style.sources?.['occumed-open'];

if (!source || source.type !== 'vector') {
  throw new Error('Flat overview mode requires the existing occumed-open vector source.');
}

style.sources = {
  'occumed-open': {
    ...source,
    tiles: ['__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf'],
    minzoom: 0,
    maxzoom: 5
  }
};

style.layers = (style.layers || []).filter((layer) =>
  (!layer.source || layer.source === 'occumed-open') &&
  !['sky', 'hillshade', 'model'].includes(layer.type)
);

style.projection = { type: 'mercator' };
delete style.terrain;
delete style.fog;

style.metadata = {
  ...(style.metadata || {}),
  'occumed:emergency-mode': 'immutable-flat-overview-only',
  'occumed:projection': 'mercator',
  'occumed:runtime-geometry': false,
  'occumed:neon-cache': false,
  'occumed:regional-routing': false,
  'occumed:atmosphere': false
};

await fs.writeFile(stylePath, `${JSON.stringify(style, null, 2)}\n`);
console.log(`Flat overview locked: Mercator, one vector source, ${style.layers.length} layers, maxzoom 5.`);
