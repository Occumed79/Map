#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { tileIdToZxy, zxyToTileId } from 'pmtiles';
import {
  openLocalPmtiles,
  visitPmtilesTileAddresses
} from './local-pmtiles.mjs';

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${key || '<end>'}.`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ['plan', 'owner-id', 'input-report', 'output']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  return result;
}

function prefixContains(prefix, tile) {
  if (tile.z < prefix.z) return false;
  const divisor = 2 ** (tile.z - prefix.z);
  return (
    Math.floor(tile.x / divisor) === prefix.x &&
    Math.floor(tile.y / divisor) === prefix.y
  );
}

const options = parseArguments(process.argv.slice(2));
const [plan, inputReport] = await Promise.all([
  fs.readFile(path.resolve(options.plan), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(options['input-report']), 'utf8').then(JSON.parse)
]);
if (plan.planVersion !== inputReport.planVersion) {
  throw new Error('Localized inputs do not match the immutable owner plan.');
}
const owner = plan.owners.find((candidate) => candidate.id === options['owner-id']);
if (!owner) throw new Error(`Owner is not present in the plan: ${options['owner-id']}`);
if (!inputReport.ownerIds?.includes(owner.id)) {
  throw new Error(`Input report was not localized for ${owner.id}.`);
}
const inputByAsset = new Map(inputReport.inputs.map((input) => [input.asset, input.path]));
const minZoom = Number(options['min-zoom'] || plan.routingZoom + 1);
const maxZoom = Number(options['max-zoom'] || 16);
const targetIds = new Set(
  (owner.exactTiles || []).map(({ z, x, y }) => zxyToTileId(z, x, y))
);
let scannedTiles = 0;
let scannedDirectories = 0;

for (const candidate of owner.candidates) {
  const filename = inputByAsset.get(candidate.asset);
  if (!filename) throw new Error(`Localized owner input is missing: ${candidate.asset}`);
  const opened = await openLocalPmtiles(filename, { cacheEntries: 2_048 });
  try {
    const scanned = await visitPmtilesTileAddresses(opened, ({ z, x, y, tileId }) => {
      if (
        z >= minZoom &&
        z <= maxZoom &&
        prefixContains(owner.prefix, { z, x, y })
      ) {
        targetIds.add(tileId);
      }
    });
    scannedTiles += scanned.addressedTiles;
    scannedDirectories += scanned.directoryCount;
  } finally {
    await opened.close();
  }
}

const targets = [...targetIds]
  .sort((left, right) => left - right)
  .map((tileId) => {
    const [z, x, y] = tileIdToZxy(tileId);
    return { z, x, y };
  });
if (!targets.length) throw new Error(`Owner ${owner.id} has no addressed output tiles.`);
const document = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  planVersion: plan.planVersion,
  selectedOwners: [{
    id: owner.id,
    prefix: owner.prefix,
    exactTiles: owner.exactTiles || [],
    requiredCandidates: owner.candidates
  }],
  targets: {
    [owner.id]: targets
  },
  totalAddressedTiles: targets.length,
  inventory: {
    candidateCount: owner.candidates.length,
    scannedTiles,
    scannedDirectories
  }
};
const output = path.resolve(options.output);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
console.log(
  `Generated ${targets.length} exact targets for ${owner.id} from ` +
  `${scannedTiles} addressed input tiles.`
);
