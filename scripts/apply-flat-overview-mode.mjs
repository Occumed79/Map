#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylePath = path.join(root, 'public', 'style', 'occumed-open.json');
const style = JSON.parse(await fs.readFile(stylePath, 'utf8'));
const source = style.sources?.['occumed-open'];

if (!source || source.type !== 'vector') {
  throw new Error('Flat surface mode requires the existing occumed-open vector source.');
}

style.sources = {
  'occumed-open': {
    ...source,
    tiles: ['__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf'],
    minzoom: 0,
    maxzoom: 5
  }
};

const physicalLayers = new Set(['land', 'landcover', 'depth']);
style.layers = (style.layers || []).filter((layer) => {
  if (['sky', 'hillshade', 'model'].includes(layer.type)) return false;
  if (!layer.source) return true;
  return layer.source === 'occumed-open' && physicalLayers.has(layer['source-layer']);
});

let landLayer = style.layers.find(
  (layer) => layer.source === 'occumed-open' && layer['source-layer'] === 'land' && layer.type === 'fill'
);
if (!landLayer) {
  landLayer = {
    id: 'occumed-flat-land-surface',
    type: 'fill',
    source: 'occumed-open',
    'source-layer': 'land',
    minzoom: 0,
    maxzoom: 24,
    paint: {
      'fill-color': '#F2F2F2',
      'fill-opacity': 1
    }
  };
  const backgroundIndex = style.layers.findLastIndex((layer) => layer.type === 'background');
  style.layers.splice(backgroundIndex + 1, 0, landLayer);
} else {
  landLayer.minzoom = 0;
  landLayer.maxzoom = 24;
  delete landLayer.filter;
  landLayer.paint = {
    ...(landLayer.paint || {}),
    'fill-opacity': 1
  };
}

style.projection = { type: 'mercator' };
delete style.terrain;
delete style.fog;

style.metadata = {
  ...(style.metadata || {}),
  'occumed:emergency-mode': 'immutable-flat-authoritative-surface',
  'occumed:projection': 'mercator',
  'occumed:physical-authority': 'occumed-world-surface.pmtiles',
  'occumed:runtime-geometry': false,
  'occumed:neon-cache': false,
  'occumed:regional-routing': false,
  'occumed:atmosphere': false
};

await fs.writeFile(stylePath, `${JSON.stringify(style, null, 2)}\n`);
console.log(`Flat surface locked: Mercator, authoritative land/landcover/depth, ${style.layers.length} layers, maxzoom 5.`);
