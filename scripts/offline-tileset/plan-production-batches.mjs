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

const options = parseArguments(process.argv.slice(2));
const plan = JSON.parse(await fs.readFile(path.resolve(options.plan), 'utf8'));
const requested = Number(options['batch-count'] || 768);
if (!Number.isSafeInteger(requested) || requested < 1 || requested > 900) {
  throw new Error('Production batch count must be between 1 and 900.');
}
if (!Array.isArray(plan.owners) || !plan.owners.length) {
  throw new Error('Immutable owner plan is empty.');
}

const batchCount = Math.min(requested, plan.owners.length);
const batches = [];
for (let index = 0; index < batchCount; index += 1) {
  const start = Math.floor(index * plan.owners.length / batchCount);
  const end = Math.floor((index + 1) * plan.owners.length / batchCount);
  const owners = plan.owners.slice(start, end);
  if (!owners.length) throw new Error(`Production batch ${index} is empty.`);
  batches.push({
    index,
    id: `batch-${String(index).padStart(4, '0')}`,
    file: `batch-${String(index).padStart(4, '0')}.pmtiles`,
    ownerIds: owners.map((owner) => owner.id),
    ownerCount: owners.length,
    candidateBytes: owners.reduce((sum, owner) => sum + Number(owner.candidateBytes || 0), 0)
  });
}

const document = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  planVersion: plan.planVersion,
  releaseTag: options.tag || 'occumed-flat-v1',
  batchCount,
  ownerCount: plan.owners.length,
  batches
};
document.batchPlanVersion = hashDocument(document);

const output = path.resolve(options.output);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
console.log(
  `Planned ${batchCount} deterministic production batches for ${plan.owners.length} owners; ` +
  `batch plan ${document.batchPlanVersion}.`
);
