#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const [style, server, starter, packageJson] = await Promise.all([
  fs.readFile(path.join(root, 'public', 'style', 'occumed-open.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'server-emergency.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts', 'start-emergency-overview.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse)
]);

const sourceEntries = Object.entries(style.sources || {});
expect(sourceEntries.length === 1, `Emergency style must contain exactly one source; found ${sourceEntries.length}.`);
expect(sourceEntries[0]?.[0] === 'occumed-open', 'Emergency vector source ID changed.');
expect(sourceEntries[0]?.[1]?.type === 'vector', 'Emergency source is not vector data.');
expect(sourceEntries[0]?.[1]?.maxzoom === 5, 'Emergency source must stop at immutable overview zoom 5.');
expect(
  JSON.stringify(sourceEntries[0]?.[1]?.tiles) === JSON.stringify(['__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf']),
  'Emergency source does not use the stable tile endpoint.'
);
expect(!style.terrain, 'Emergency style still enables a terrain source.');
expect(!(style.layers || []).some((layer) => layer.type === 'hillshade'), 'Emergency style still contains hillshade.');
expect(
  (style.layers || []).every((layer) => !layer.source || layer.source === 'occumed-open'),
  'A runtime layer still references a second source.'
);
expect(style.metadata?.['occumed:emergency-mode'] === 'immutable-overview-only', 'Emergency metadata lock is missing.');

for (const forbidden of [
  'neon-navigation-tile-cache',
  'world-tile-gateway',
  'mergeVectorTiles',
  'overscaleVectorLayer',
  'copyVectorLayer',
  'NAV_DATABASE_URL_'
]) {
  expect(!server.includes(forbidden), `Emergency server still references ${forbidden}.`);
}

expect(server.includes("new PMTiles(source)"), 'Emergency server does not read the immutable PMTiles archive.');
expect(server.includes("'occumed-world-overview.pmtiles'"), 'Emergency server does not use the overview archive.');
expect(starter.includes("'occumed-world-overview.pmtiles'"), 'Emergency starter does not localize the overview archive.');
expect(!starter.includes('occumed-world-surface.pmtiles'), 'Emergency starter still downloads the surface archive.');
expect(packageJson.scripts?.start === 'node scripts/start-emergency-overview.mjs', 'Package start command does not use emergency mode.');

if (failures.length) {
  console.error('Emergency immutable overview validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Emergency overview validated: one immutable source, maxzoom 5, no Neon, no runtime merging, no synthesis, and no terrain dependency.');
