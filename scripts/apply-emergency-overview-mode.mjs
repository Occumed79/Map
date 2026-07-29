#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylePath = path.join(root, 'public', 'style', 'occumed-open.json');
const style = JSON.parse(await fs.readFile(stylePath, 'utf8'));
const source = style.sources?.['occumed-open'];
const configuredMaxZoom = Number(process.env.OCCUMED_STYLE_MAX_ZOOM || 5);
const mode = process.env.OCCUMED_STYLE_MODE?.trim() || 'immutable-overview-only';

if (!source || source.type !== 'vector') {
  throw new Error('One-source mode requires the existing occured-open vector source.');
}
if (!Number.isSafeInteger(configuredMaxZoom) || configuredMaxZoom < 0 || configuredMaxZoom > 24) {
  throw new Error('OCCUMED_STYLE_MAX_ZOOM must be an integer from 0 through 24.');
}
if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(mode)) {
  throw new Error('OCCUMED_STYLE_MODE contains unsupported characters.');
}

style.sources = {
  'occumed-open': {
    ...source,
    tiles: ['__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf'],
    minzoom: 0,
    maxzoom: configuredMaxZoom
  }
};

style.layers = (style.layers || []).filter((layer) => !layer.source || layer.source === 'occumed-open');
delete style.terrain;

style.metadata = {
  ...(style.metadata || {}),
  'occumed:emergency-mode': mode,
  'occumed:runtime-geometry': false,
  'occumed:neon-cache': false,
  'occumed:regional-routing': false
};

await fs.writeFile(stylePath, `${JSON.stringify(style, null, 2)}\n`);
console.log(`One-source style locked: mode ${mode}, ${style.layers.length} layers, maxzoom ${configuredMaxZoom}.`);
