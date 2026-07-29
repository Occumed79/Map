#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
    result[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ['plan', 'output-dir', 'report']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  if (!result.targets && !result['owner-id']) {
    throw new Error('Either --targets or --owner-id is required.');
  }
  return result;
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  const handle = await fs.open(filename, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

function releaseUrl(plan, asset) {
  return `https://github.com/${plan.repository}/releases/download/` +
    `${encodeURIComponent(plan.releaseTag)}/${encodeURIComponent(asset)}`;
}

async function validLockedFile(filename, lock) {
  try {
    const stat = await fs.stat(filename);
    return (
      stat.isFile() &&
      stat.size === lock.bytes &&
      await hashFile(filename) === lock.sha256
    );
  } catch {
    return false;
  }
}

async function downloadLocked(plan, lock, outputDir) {
  const destination = path.join(outputDir, lock.asset);
  if (await validLockedFile(destination, lock)) {
    console.log(`Using SHA-locked input ${lock.asset}.`);
    return {
      asset: lock.asset,
      path: destination,
      bytes: lock.bytes,
      sha256: lock.sha256,
      reused: true
    };
  }

  const temporary = `${destination}.pending-${process.pid}-${Date.now()}`;
  const response = await fetch(lock.url || releaseUrl(plan, lock.asset), {
    redirect: 'follow',
    headers: { 'User-Agent': 'Occu-Med-Map/offline-input-localizer' }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download ${lock.asset}: HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared !== lock.bytes) {
    throw new Error(
      `Published byte count changed for ${lock.asset}: expected ${lock.bytes}, received ${declared}.`
    );
  }

  const handle = await fs.open(temporary, 'wx');
  const hash = createHash('sha256');
  let bytes = 0;
  let nextProgress = 256 * 1024 * 1024;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      await handle.write(buffer);
      hash.update(buffer);
      bytes += buffer.byteLength;
      if (bytes >= nextProgress) {
        console.log(`[${lock.asset}] ${bytes}/${lock.bytes} bytes downloaded.`);
        nextProgress += 256 * 1024 * 1024;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const digest = hash.digest('hex');
  if (bytes !== lock.bytes || digest !== lock.sha256) {
    throw new Error(
      `Input lock failed for ${lock.asset}: ${bytes}/${lock.bytes} bytes, ${digest}/${lock.sha256}.`
    );
  }
  await fs.rename(temporary, destination);
  const verified = await validLockedFile(destination, lock);
  if (!verified) throw new Error(`Promoted input failed verification: ${lock.asset}.`);
  console.log(`Localized ${lock.asset}: ${bytes} bytes, SHA-256 ${digest}.`);
  return {
    asset: lock.asset,
    path: destination,
    bytes,
    sha256: digest,
    reused: false
  };
}

const options = parseArguments(process.argv.slice(2));
const plan = JSON.parse(await fs.readFile(path.resolve(options.plan), 'utf8'));
const targets = options.targets
  ? JSON.parse(await fs.readFile(path.resolve(options.targets), 'utf8'))
  : null;
const selectedIds = new Set(
  options['owner-id']
    ? [options['owner-id']]
    : (targets.selectedOwners || []).map((owner) => owner.id)
);
const selected = plan.owners.filter((owner) => selectedIds.has(owner.id));
if (selected.length !== selectedIds.size) throw new Error('Representative owner selection is not in the locked plan.');

const locks = new Map();
for (const input of [plan.inputs.overview, plan.inputs.surface]) locks.set(input.asset, input);
for (const selectedOwner of selected) {
  const owner = selected.find((candidate) => candidate.id === selectedOwner.id);
  if (!owner) throw new Error(`Selected owner is missing from plan: ${selectedOwner.id}`);
  const requiredNames = new Set(
    (
      targets?.selectedOwners?.find((candidate) => candidate.id === selectedOwner.id)
        ?.requiredCandidates ||
      owner.candidates
    ).map((candidate) => candidate.asset)
  );
  for (const candidate of owner.candidates.filter((item) => requiredNames.has(item.asset))) {
    locks.set(candidate.asset, {
      ...candidate,
      url: releaseUrl(plan, candidate.asset)
    });
  }
}

const outputDir = path.resolve(options['output-dir']);
await fs.mkdir(outputDir, { recursive: true });
const results = [];
for (const lock of [...locks.values()].sort((left, right) => left.asset.localeCompare(right.asset))) {
  results.push(await downloadLocked(plan, lock, outputDir));
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  planVersion: plan.planVersion,
  ownerIds: [...selectedIds].sort(),
  inputCount: results.length,
  totalBytes: results.reduce((sum, result) => sum + result.bytes, 0),
  inputs: results
};
const reportPath = path.resolve(options.report);
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Localized ${results.length} locked inputs totaling ${report.totalBytes} bytes.`);
