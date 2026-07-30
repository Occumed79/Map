#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const [style, server, starter, packageJson, mainCss] = await Promise.all([
  fs.readFile(path.join(root, 'public', 'style', 'occumed-open.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'server-flat.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts', 'start-flat-overview.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'src', 'flat-overview.css'), 'utf8')
]);

const sourceEntries = Object.entries(style.sources || {});
expect(sourceEntries.length === 1, `Flat style must contain exactly one source; found ${sourceEntries.length}.`);
expect(sourceEntries[0]?.[0] === 'occumed-open', 'Flat vector source ID changed.');
expect(sourceEntries[0]?.[1]?.type === 'vector', 'Flat source is not vector data.');
expect(sourceEntries[0]?.[1]?.maxzoom === 5, 'Flat source must stop at immutable physical-surface zoom 5.');
expect(
  JSON.stringify(sourceEntries[0]?.[1]?.tiles) === JSON.stringify(['__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf']),
  'Flat source does not use the stable tile endpoint.'
);
expect(style.projection?.type === 'mercator', 'Flat style is not locked to Mercator projection.');
expect(!style.terrain, 'Flat style still enables terrain.');
expect(!style.fog, 'Flat style still enables globe fog.');
expect(!(style.layers || []).some((layer) => ['sky', 'hillshade', 'model'].includes(layer.type)), 'Flat style still contains globe, terrain, or model layers.');
expect(
  (style.layers || []).every((layer) => {
    if (!layer.source) return true;
    return layer.source === 'occumed-open' && ['land', 'landcover', 'depth'].includes(layer['source-layer']);
  }),
  'Flat style references a layer not present in the authoritative physical surface.'
);
expect(
  (style.layers || []).some((layer) =>
    layer.source === 'occumed-open' && layer['source-layer'] === 'land' && layer.type === 'fill'
  ),
  'Flat style has no visible authoritative land fill.'
);
expect(style.metadata?.['occumed:emergency-mode'] === 'immutable-flat-authoritative-surface', 'Authoritative flat-surface metadata lock is missing.');
expect(style.metadata?.['occumed:projection'] === 'mercator', 'Flat projection metadata is missing.');
expect(style.metadata?.['occumed:physical-authority'] === 'occumed-world-surface.pmtiles', 'Physical-source authority metadata is missing.');
expect(mainCss.includes('occumed-atmosphere-bloom'), 'Flat stylesheet does not disable the globe atmosphere halo.');

for (const forbidden of [
  'neon-navigation-tile-cache',
  'world-tile-gateway',
  'mergeVectorTiles',
  'overscaleVectorLayer',
  'copyVectorLayer',
  'NAV_DATABASE_URL_'
]) {
  expect(!server.includes(forbidden), `Flat server still references ${forbidden}.`);
}

expect(server.includes("new PMTiles(source)"), 'Flat server does not read the immutable PMTiles archive.');
expect(server.includes("'occumed-world-overview.pmtiles'"), 'Flat server stable localized archive path changed.');
expect(starter.includes("'occumed-world-surface.pmtiles'"), 'Flat starter does not download the authoritative world surface.');
expect(starter.includes("'occumed-world-overview.pmtiles'"), 'Flat starter does not preserve the stable localized server filename.');
expect(starter.includes('archive.getMetadata()'), 'Flat starter does not inspect PMTiles layer metadata.');
for (const layer of ['land', 'landcover', 'depth']) {
  expect(starter.includes(`'${layer}'`), `Flat starter does not require the ${layer} layer.`);
}
expect(packageJson.scripts?.start === 'node scripts/start-flat-overview.mjs', 'Package start command does not use flat mode.');

if (failures.length) {
  console.error('Flat authoritative-surface validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Flat surface validated: Mercator, one immutable source, authoritative land/landcover/depth, no globe, no terrain, no Neon, and no runtime merging.');
