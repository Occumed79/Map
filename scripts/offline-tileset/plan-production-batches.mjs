#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  for (const required of ['plan', 'output']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => key !== 'generatedAt')
      .map((key) => [key, canonical(value[key])])
  );
}

function hashDocument(document) {
  return createHash('sha256')
    .update(`${JSON.stringify(canonical(document))}\n`)
    .digest('hex');
}

function prefixContains(prefix, candidate) {
  if (prefix.z > candidate.z) return false;
  const divisor = 2 ** (candidate.z - prefix.z);
  return (
    Math.floor(candidate.x / divisor) === prefix.x &&
    Math.floor(candidate.y / divisor) === prefix.y
  );
}

function children(prefix) {
  const next = prefix.z + 1;
  return [
    { z: next, x: prefix.x * 2, y: prefix.y * 2 },
    { z: next, x: prefix.x * 2 + 1, y: prefix.y * 2 },
    { z: next, x: prefix.x * 2, y: prefix.y * 2 + 1 },
    { z: next, x: prefix.x * 2 + 1, y: prefix.y * 2 + 1 }
  ];
}

function uniqueCandidateBytes(owners) {
  const assets = new Map();
  for (const owner of owners) {
    for (const candidate of owner.candidates) assets.set(candidate.asset, candidate.bytes);
  }
  return [...assets.values()].reduce((sum, bytes) => sum + Number(bytes || 0), 0);
}

function node(prefix, owners) {
  return {
    prefix,
    owners,
    ownerCount: owners.length,
    candidateBytes: uniqueCandidateBytes(owners),
    score: uniqueCandidateBytes(owners) + owners.length * 10_000_000
  };
}

const options = parseArguments(process.argv.slice(2));
const plan = JSON.parse(await fs.readFile(path.resolve(options.plan), 'utf8'));
const requested = Number(options['batch-count'] || 768);
const startZoom = Number(options['start-zoom'] || 4);
if (!Number.isSafeInteger(requested) || requested < 1 || requested > 900) {
  throw new Error('Production batch count must be between 1 and 900.');
}
if (!Number.isSafeInteger(startZoom) || startZoom < 0 || startZoom > plan.routingZoom) {
  throw new Error('Production start zoom is invalid.');
}
if (!Array.isArray(plan.owners) || !plan.owners.length) {
  throw new Error('Immutable owner plan is empty.');
}

const active = [];
const width = 2 ** startZoom;
for (let y = 0; y < width; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const prefix = { z: startZoom, x, y };
    const owners = plan.owners.filter((owner) => prefixContains(prefix, owner.prefix));
    if (owners.length) active.push(node(prefix, owners));
  }
}

while (active.length < requested) {
  const candidates = active
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.prefix.z < plan.maxPrefixZoom)
    .map(({ entry, index }) => {
      const split = children(entry.prefix)
        .map((prefix) => node(prefix, entry.owners.filter((owner) => prefixContains(prefix, owner.prefix))))
        .filter((child) => child.owners.length);
      return { entry, index, split, increase: split.length - 1 };
    })
    .filter(({ increase }) => increase > 0 && active.length + increase <= requested)
    .sort((left, right) =>
      right.entry.score - left.entry.score ||
      left.entry.prefix.z - right.entry.prefix.z ||
      left.index - right.index
    );
  if (!candidates.length) break;
  const selected = candidates[0];
  active.splice(selected.index, 1, ...selected.split);
}

active.sort((left, right) =>
  left.prefix.z - right.prefix.z ||
  left.prefix.x - right.prefix.x ||
  left.prefix.y - right.prefix.y
);
const assigned = new Set();
const batches = active.map((entry, index) => {
  for (const owner of entry.owners) {
    if (assigned.has(owner.id)) throw new Error(`Production owner assigned twice: ${owner.id}`);
    assigned.add(owner.id);
  }
  const id = `batch-${String(index).padStart(4, '0')}`;
  return {
    index,
    id,
    file: `${id}.pmtiles`,
    prefix: entry.prefix,
    ownerIds: entry.owners.map((owner) => owner.id),
    sourceOwnerCount: entry.owners.length,
    candidateBytes: entry.candidateBytes
  };
});
if (assigned.size !== plan.owners.length) {
  throw new Error(`Production batch coverage is incomplete: ${assigned.size}/${plan.owners.length}.`);
}

const document = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  planVersion: plan.planVersion,
  releaseTag: options.tag || 'occumed-flat-v1',
  requestedBatchCount: requested,
  batchCount: batches.length,
  sourceOwnerCount: plan.owners.length,
  batches
};
document.batchPlanVersion = hashDocument(document);

const output = path.resolve(options.output);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
console.log(
  `Planned ${batches.length} non-overlapping spatial production batches for ` +
  `${plan.owners.length} source owners; batch plan ${document.batchPlanVersion}.`
);
