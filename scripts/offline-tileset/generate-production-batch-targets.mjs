#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { tileIdToZxy, zxyToTileId } from 'pmtiles';
import { openPmtiles, visitPmtilesTileAddresses } from './local-pmtiles.mjs';

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
  for (const required of ['plan', 'batch-plan', 'batch-index', 'output']) {
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

function tileKey(tile) {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

const options = parseArguments(process.argv.slice(2));
const [plan, batchPlan] = await Promise.all([
  fs.readFile(path.resolve(options.plan), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(options['batch-plan']), 'utf8').then(JSON.parse)
]);
if (plan.planVersion !== batchPlan.planVersion) {
  throw new Error('Production batch plan does not match the immutable owner plan.');
}
const batchIndex = Number(options['batch-index']);
const batch = batchPlan.batches?.find((candidate) => candidate.index === batchIndex);
if (!batch) throw new Error(`Production batch is missing: ${batchIndex}`);

const ownerIds = new Set(batch.ownerIds);
const owners = plan.owners.filter((owner) => ownerIds.has(owner.id));
if (owners.length !== ownerIds.size) {
  throw new Error(`Batch ${batch.id} owner selection is incomplete.`);
}
const candidateOwners = new Map();
for (const owner of owners) {
  for (const candidate of owner.candidates) {
    const existing = candidateOwners.get(candidate.asset) || { candidate, owners: [] };
    existing.owners.push(owner);
    candidateOwners.set(candidate.asset, existing);
  }
}

const tileOwners = new Map();
const ownerTileCounts = new Map(owners.map((owner) => [owner.id, 0]));
function assign(owner, tile) {
  const id = zxyToTileId(tile.z, tile.x, tile.y);
  const existing = tileOwners.get(id);
  if (existing && existing !== owner.id) {
    throw new Error(
      `Exact production tile ${tileKey(tile)} belongs to both ${existing} and ${owner.id}.`
    );
  }
  if (!existing) {
    tileOwners.set(id, owner.id);
    ownerTileCounts.set(owner.id, ownerTileCounts.get(owner.id) + 1);
  }
}

for (const owner of owners) {
  for (const tile of owner.exactTiles || []) assign(owner, tile);
}

let scannedTiles = 0;
let scannedDirectories = 0;
const scannedInputs = [];

async function scanInput({ label, location, candidateOwnerList }) {
  const opened = await openPmtiles(location, { cacheEntries: 8_192 });
  try {
    const scanned = await visitPmtilesTileAddresses(opened, ({ z, x, y }) => {
      if (z <= plan.routingZoom || z > 16) return;
      const tile = { z, x, y };
      const matches = candidateOwnerList.filter((owner) => prefixContains(owner.prefix, tile));
      if (matches.length > 1) {
        throw new Error(
          `${label} maps ${tileKey(tile)} to ${matches.length} owners in ${batch.id}.`
        );
      }
      if (matches.length === 1) assign(matches[0], tile);
    });
    scannedTiles += scanned.addressedTiles;
    scannedDirectories += scanned.directoryCount;
    scannedInputs.push({
      label,
      addressedTiles: scanned.addressedTiles,
      directoryCount: scanned.directoryCount
    });
  } finally {
    await opened.close();
  }
}

// Preserve authoritative physical coverage even where a regional bounding box
// intersects an owner but the regional archive has no addressed tile there.
await scanInput({
  label: 'world-surface',
  location: plan.inputs.surface.url,
  candidateOwnerList: owners
});
await scanInput({
  label: 'world-overview',
  location: plan.inputs.overview.url,
  candidateOwnerList: owners
});

for (const { candidate, owners: candidateOwnerList } of [...candidateOwners.values()]
  .sort((left, right) => left.candidate.asset.localeCompare(right.candidate.asset))) {
  await scanInput({
    label: candidate.asset,
    location: candidate.url,
    candidateOwnerList
  });
}

// A wholly empty batch can occur at a regional bounding-box fringe over open
// ocean. Emit one deterministic empty MVT address so the immutable batch has a
// valid PMTiles container; no geometry is synthesized.
let emptyBatchAnchor = null;
if (!tileOwners.size) {
  const owner = owners[0];
  const z = Math.max(plan.routingZoom + 1, owner.prefix.z);
  const scale = 2 ** (z - owner.prefix.z);
  emptyBatchAnchor = {
    z,
    x: owner.prefix.x * scale,
    y: owner.prefix.y * scale
  };
  assign(owner, emptyBatchAnchor);
}

const activeOwners = owners.filter((owner) => ownerTileCounts.get(owner.id) > 0);
const emptyOwnerIds = owners
  .filter((owner) => ownerTileCounts.get(owner.id) === 0)
  .map((owner) => owner.id);
const targets = [...tileOwners.keys()]
  .sort((left, right) => left - right)
  .map((tileId) => {
    const [z, x, y] = tileIdToZxy(tileId);
    return { z, x, y };
  });
const document = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  planVersion: plan.planVersion,
  batchPlanVersion: batchPlan.batchPlanVersion,
  batch: {
    ...batch,
    activeOwnerIds: activeOwners.map((owner) => owner.id),
    emptyOwnerIds,
    emptyBatchAnchor,
    ownerTileCounts: Object.fromEntries([...ownerTileCounts].sort())
  },
  selectedOwners: activeOwners.map((owner) => ({
    id: owner.id,
    prefix: owner.prefix,
    exactTiles: owner.exactTiles || [],
    requiredCandidates: owner.candidates
  })),
  targets: {
    [batch.id]: targets
  },
  totalAddressedTiles: targets.length,
  inventory: {
    ownerCount: owners.length,
    activeOwnerCount: activeOwners.length,
    emptyOwnerCount: emptyOwnerIds.length,
    candidateCount: candidateOwners.size,
    scannedTiles,
    scannedDirectories,
    scannedInputs
  }
};
const output = path.resolve(options.output);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
console.log(
  `Generated ${targets.length} exact tiles for ${batch.id} across ` +
  `${activeOwners.length} active and ${emptyOwnerIds.length} empty source owners ` +
  `from ${candidateOwners.size} regional inputs plus authoritative surface/overview.`
);
