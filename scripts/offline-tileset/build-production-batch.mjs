#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

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
  for (const required of ['plan', 'batch-plan', 'batch-index', 'targets', 'output-dir']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  return result;
}

async function runNode(script, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${path.basename(script)} terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`${path.basename(script)} exited with ${code}.`));
      else resolve();
    });
  });
}

const options = parseArguments(process.argv.slice(2));
const [plan, batchPlan, targets] = await Promise.all([
  fs.readFile(path.resolve(options.plan), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(options['batch-plan']), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(options.targets), 'utf8').then(JSON.parse)
]);
if (
  plan.planVersion !== batchPlan.planVersion ||
  plan.planVersion !== targets.planVersion ||
  batchPlan.batchPlanVersion !== targets.batchPlanVersion
) {
  throw new Error('Production plan, batch plan, and targets do not share one immutable version.');
}
const batchIndex = Number(options['batch-index']);
const batch = batchPlan.batches?.find((candidate) => candidate.index === batchIndex);
if (!batch || targets.batch?.id !== batch.id) {
  throw new Error(`Production batch metadata mismatch: ${batchIndex}.`);
}

const batchOwnerIds = new Set(batch.ownerIds);
const selectedOwnerIds = new Set(targets.selectedOwners.map((owner) => owner.id));
const activeOwnerIds = new Set(targets.batch.activeOwnerIds || []);
const emptyOwnerIds = new Set(targets.batch.emptyOwnerIds || []);
if (
  selectedOwnerIds.size !== activeOwnerIds.size ||
  [...selectedOwnerIds].some((id) => !activeOwnerIds.has(id))
) {
  throw new Error(`Active production owner inventory is inconsistent for ${batch.id}.`);
}
if (
  activeOwnerIds.size + emptyOwnerIds.size !== batchOwnerIds.size ||
  [...activeOwnerIds, ...emptyOwnerIds].some((id) => !batchOwnerIds.has(id))
) {
  throw new Error(`Active/empty production owner partition is incomplete for ${batch.id}.`);
}
const owners = plan.owners.filter((owner) => activeOwnerIds.has(owner.id));
if (owners.length !== activeOwnerIds.size) {
  throw new Error(`Active production owner lookup is incomplete for ${batch.id}.`);
}

const regionalByAsset = new Map();
for (const owner of owners) {
  for (const candidate of owner.candidates) regionalByAsset.set(candidate.asset, candidate);
}
const outputDir = path.resolve(options['output-dir']);
await fs.mkdir(path.join(outputDir, 'batches'), { recursive: true });
await fs.mkdir(path.join(outputDir, 'reports/batches'), { recursive: true });
await fs.mkdir(path.join(outputDir, 'work'), { recursive: true });
const output = path.join(outputDir, `batches/${batch.file}`);
const report = path.join(outputDir, `reports/batches/${batch.id}.json`);
if (await fs.stat(output).catch(() => null) || await fs.stat(report).catch(() => null)) {
  throw new Error(`Immutable production output already exists: ${batch.id}`);
}

const regionalArgs = [...regionalByAsset.values()]
  .sort((left, right) => left.asset.localeCompare(right.asset))
  .flatMap((candidate) => ['--regional', `${candidate.asset}=${candidate.url}`]);
await runNode(path.join(scriptDirectory, 'build-archive.mjs'), [
  '--targets', path.resolve(options.targets),
  '--target-name', batch.id,
  '--overview', plan.inputs.overview.url,
  '--surface', plan.inputs.surface.url,
  ...regionalArgs,
  '--output', output,
  '--report', report,
  '--workdir', path.join(outputDir, `work/${batch.id}`),
  '--manifest-file', batch.file,
  '--concurrency', String(options.concurrency || 8)
]);

const built = JSON.parse(await fs.readFile(report, 'utf8'));
const maxBytes = Number(options['max-bytes'] || 1_900_000_000);
if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_000_000) {
  throw new Error('Invalid production batch byte limit.');
}
if (built.bytes > maxBytes) {
  throw new Error(
    `${batch.id} produced ${built.bytes} bytes, exceeding the ${maxBytes}-byte release limit.`
  );
}
built.batch = batch;
built.planVersion = plan.planVersion;
built.batchPlanVersion = batchPlan.batchPlanVersion;
built.owners = owners.map((owner) => ({
  id: owner.id,
  prefix: owner.prefix,
  exactTiles: owner.exactTiles || []
}));
built.emptyOwnerIds = [...emptyOwnerIds].sort();
built.sourceOwnerCount = batch.ownerIds.length;
built.activeSourceOwnerCount = owners.length;
const pending = `${report}.pending-${process.pid}`;
await fs.writeFile(pending, `${JSON.stringify(built, null, 2)}\n`, { flag: 'wx' });
await fs.rename(pending, report);
console.log(
  `${batch.id} is release-ready: ${built.bytes} bytes, ${built.addressedTiles} exact tiles, ` +
  `${owners.length} active and ${emptyOwnerIds.size} empty source owners.`
);
