#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  computeImmutableArtifactVersion,
  validateImmutableManifest
} from '../../src/server/immutable-world-tileset.js';

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
  for (const required of ['plan', 'batch-plan', 'repository', 'tag', 'output']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  return result;
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Occu-Med-Map/production-finalizer',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

async function releaseAssets(repository, tag, token) {
  const release = await fetchJson(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    token
  );
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchJson(
      `${release.assets_url}?per_page=100&page=${page}`,
      token
    );
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  return assets;
}

function lockedAsset(asset, expectedName) {
  if (!asset) throw new Error(`Published production asset is missing: ${expectedName}`);
  const sha256 = String(asset.digest || '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Published production asset lacks SHA-256 lock: ${expectedName}`);
  }
  return {
    file: expectedName,
    bytes: Number(asset.size),
    sha256
  };
}

const options = parseArguments(process.argv.slice(2));
const [plan, batchPlan, assets] = await Promise.all([
  fs.readFile(path.resolve(options.plan), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(options['batch-plan']), 'utf8').then(JSON.parse),
  releaseAssets(options.repository, options.tag, process.env.GITHUB_TOKEN)
]);
if (plan.planVersion !== batchPlan.planVersion) {
  throw new Error('Production batch plan does not match the immutable owner plan.');
}
const byName = new Map(assets.map((asset) => [asset.name, asset]));
const foundation = {
  id: 'foundation',
  ...lockedAsset(byName.get('foundation.pmtiles'), 'foundation.pmtiles'),
  maxZoom: plan.routingZoom
};
const ownerById = new Map(plan.owners.map((owner) => [owner.id, owner]));
const assigned = new Set();
const owners = [];
const uniqueAssets = new Map([[foundation.file, foundation]]);
for (const batch of batchPlan.batches) {
  const archive = lockedAsset(byName.get(batch.file), batch.file);
  uniqueAssets.set(archive.file, archive);
  for (const ownerId of batch.ownerIds) {
    if (assigned.has(ownerId)) throw new Error(`Production owner is assigned twice: ${ownerId}`);
    const owner = ownerById.get(ownerId);
    if (!owner) throw new Error(`Production owner is not in the immutable plan: ${ownerId}`);
    assigned.add(ownerId);
    owners.push({
      id: owner.id,
      prefix: owner.prefix,
      exactTiles: owner.exactTiles || [],
      ...archive,
      batchId: batch.id
    });
  }
}
if (assigned.size !== plan.owners.length) {
  throw new Error(`Published production owner coverage is incomplete: ${assigned.size}/${plan.owners.length}.`);
}
owners.sort((left, right) =>
  left.prefix.z - right.prefix.z ||
  left.prefix.x - right.prefix.x ||
  left.prefix.y - right.prefix.y
);
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  planVersion: plan.planVersion,
  batchPlanVersion: batchPlan.batchPlanVersion,
  browserSourceId: 'occumed-open',
  minZoom: 0,
  maxZoom: 16,
  complete: true,
  validationFixture: false,
  logicalOwnerCount: plan.logicalOwnerCount,
  plannedOwnerCount: plan.plannedOwnerCount,
  builtOwnerCount: owners.length,
  batchCount: batchPlan.batchCount,
  defaultOwner: foundation.id,
  totalBytes: [...uniqueAssets.values()].reduce((sum, asset) => sum + asset.bytes, 0),
  assetBaseUrl: `https://github.com/${options.repository}/releases/download/${encodeURIComponent(options.tag)}/`,
  authorities: {
    land: 'world-surface',
    depth: 'world-surface',
    landcover: 'world-overview',
    cartography: 'regional-owner'
  },
  runtimePolicy: {
    neonTileCache: false,
    runtimeShardMerge: false,
    runtimeLandcoverSynthesis: false,
    runtimeGeometry: false,
    parentChildStretching: false
  },
  foundation,
  owners
};
manifest.artifactVersion = computeImmutableArtifactVersion(manifest);
validateImmutableManifest(manifest);

const output = path.resolve(options.output);
await fs.mkdir(path.dirname(output), { recursive: true });
const pending = `${output}.pending-${process.pid}`;
await fs.writeFile(pending, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
await fs.rename(pending, output);
console.log(
  `Finalized complete production manifest ${manifest.artifactVersion}: ` +
  `${owners.length} owners in ${batchPlan.batchCount} archives, ${manifest.totalBytes} unique bytes.`
);
