#!/usr/bin/env node

import { inspectVectorTile } from '../src/server/mvt.js';
import { WorldTileGateway } from '../src/server/world-tile-gateway.js';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--manifest') options.manifest = argv[++index];
    else if (key === '--release-base') options.releaseBase = argv[++index];
  }
  for (const required of ['manifest', 'releaseBase']) {
    if (!options[required]) throw new Error(`Missing --${required}.`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const releaseBase = options.releaseBase.replace(/\/$/, '');
const gateway = new WorldTileGateway({
  manifestUrl: options.manifest,
  releaseAssetUrl: (asset) => `${releaseBase}/${encodeURIComponent(asset)}`
});

const checks = [
  { name: 'globe', z: 0, x: 0, y: 0, requireDetail: true },
  { name: 'North America and US–Mexico', z: 6, x: 11, y: 25, requireDetail: true },
  { name: 'multi-shard Europe', z: 6, x: 33, y: 21, requireDetail: true },
  { name: 'Russia east of the antimeridian', z: 6, x: 63, y: 15 },
  { name: 'Russia/Alaska west of the antimeridian', z: 6, x: 0, y: 15 }
];

const results = [];
for (const check of checks) {
  const startedAt = performance.now();
  const first = await gateway.resolveTile(check.z, check.x, check.y);
  const layers = inspectVectorTile(first);
  const second = await gateway.resolveTile(check.z, check.x, check.y);

  if (!first.equals(second)) {
    throw new Error(`${check.name}: cached virtual tile differs from its initial result.`);
  }
  if (!layers.land?.featureCount) {
    throw new Error(`${check.name}: continuous worldwide land layer is missing.`);
  }
  if (check.name === 'globe' && !layers.depth?.featureCount) {
    throw new Error(`${check.name}: continuous worldwide bathymetry layer is missing.`);
  }
  if (
    check.requireDetail &&
    !Object.keys(layers).some((name) => name !== 'land')
  ) {
    throw new Error(`${check.name}: basemap detail layers are missing.`);
  }

  results.push({
    name: check.name,
    tile: `${check.z}/${check.x}/${check.y}`,
    bytes: first.byteLength,
    layers: Object.fromEntries(
      Object.entries(layers).map(([name, layer]) => [name, layer.featureCount])
    ),
    firstResolveMs: Math.round(performance.now() - startedAt)
  });
}

console.log(JSON.stringify(results, null, 2));
console.log('Live worldwide tile smoke checks passed across the globe, continental boundaries, and antimeridian.');
