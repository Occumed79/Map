#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--phase') options.phase = argv[++index];
    else if (key === '--plan') options.plan = argv[++index];
    else if (key === '--manifest') options.manifest = argv[++index];
    else if (key === '--output') options.output = argv[++index];
  }
  if (!options.phase) throw new Error('Missing --phase.');
  if (!options.output) throw new Error('Missing --output.');
  return options;
}

const options = parseArgs(process.argv.slice(2));
const status = {
  version: 1,
  phase: options.phase,
  updatedAt: new Date().toISOString(),
  repository: process.env.GITHUB_REPOSITORY || null,
  branch: process.env.GITHUB_REF_NAME || null,
  runId: process.env.GITHUB_RUN_ID || null,
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
  runUrl:
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
  headSha: process.env.GITHUB_SHA || null,
  releaseTag: process.env.WORLD_RELEASE_TAG || 'occumed-world-v1',
  bucketCount: Number(process.env.WORLD_BUCKETS || 6)
};

if (options.plan) {
  const plan = JSON.parse(await fs.readFile(options.plan, 'utf8'));
  const regions = plan.include || [];
  status.plannedRegionCount = regions.length;
  status.plannedByContinent = Object.fromEntries(
    [...regions.reduce((counts, region) => {
      counts.set(region.continent, (counts.get(region.continent) || 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right))
  );
}

if (options.manifest) {
  const manifest = JSON.parse(await fs.readFile(options.manifest, 'utf8'));
  status.plannedRegionCount = manifest.plannedRegionCount;
  status.availableRegionCount = manifest.availableRegionCount;
  status.missingRegionCount = manifest.missingRegionCount;
  status.missingRegions = manifest.missingRegions;
  status.manifestGeneratedAt = manifest.generatedAt;
  status.complete = manifest.missingRegionCount === 0;
}

for (let bucket = 0; bucket < status.bucketCount; bucket += 1) {
  const value = process.env[`BUCKET_${bucket}_RESULT`];
  if (value) {
    status.bucketResults ||= {};
    status.bucketResults[String(bucket)] = value;
  }
}

await fs.mkdir(path.dirname(options.output), { recursive: true });
await fs.writeFile(options.output, `${JSON.stringify(status, null, 2)}\n`);
console.log(JSON.stringify(status, null, 2));
