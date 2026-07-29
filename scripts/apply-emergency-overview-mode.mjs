#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylePath = path.join(root, 'public', 'style', 'occumed-open.json');
const style = JSON.parse(await fs.readFile(stylePath, 'utf8'));
const source = style.sources?.['occumed-open'];

if (!source || source.type !== 'vector') {
  throw new Error('Emergency overview mode requires the existing occured-open vector source.');
}

style.sources = {
  'occumed-open': {
    ...source,
    tiles: ['__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf'],
    minzoom: 0,
    maxzoom: 5
  }
};

style.layers = (style.layers || []).filter((layer) => !layer.source || layer.source === 'occumed-open');
delete style.terrain;

style.metadata = {
  ...(style.metadata || {}),
  'occumed:emergency-mode': 'immutable-overview-only',
  'occumed:runtime-geometry': false,
  'occumed:neon-cache': false,
  'occumed:regional-routing': false
};

await fs.writeFile(stylePath, `${JSON.stringify(style, null, 2)}\n`);
console.log(`Emergency overview mode locked: one vector source, ${style.layers.length} layers, maxzoom 5.`);
