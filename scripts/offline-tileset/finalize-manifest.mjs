#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { computeImmutableArtifactVersion, validateImmutableManifest } from '../../src/server/immutable-world-tileset.js';

function parseArguments(argv) {
  const result = { owners: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
    const name = key.slice(2);
    if (name === 'owner') result.owners.push(value);
    else result[name] = value;
    index += 1;
  }
  for (const required of ['plan', 'foundation', 'output']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  return result;
}

const options = parseArguments(process.argv.slice(2));
const ownerReportFiles = [...options.owners];
if (options['owner-dir']) {
  const ownerDirectory = path.resolve(options['owner-dir']);
  const entries = await fs.readdir(ownerDirectory, { withFileTypes: true });
  ownerReportFiles.push(
    ...entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(ownerDirectory, entry.name))
  );
}
const [plan, foundationReport, ...ownerReports] = await Promise.all([
  fs.readFile(path.resolve(options.plan), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(options.foundation), 'utf8').then(JSON.parse),
  ...[...new Set(ownerReportFiles)].map((filename) =>
    fs.readFile(path.resolve(filename), 'utf8').then(JSON.parse)
  )
]);
if (plan.schemaVersion !== 1 || !plan.planVersion) {
  throw new Error('Immutable owner plan is invalid.');
}

const foundation = {
  id: 'foundation',
  file: foundationReport.file,
  bytes: foundationReport.bytes,
  sha256: foundationReport.sha256,
  maxZoom: foundationReport.maxZoom
};
const owners = ownerReports
  .map((report) => ({
    id: report.owner.id,
    prefix: report.owner.prefix,
    exactTiles: report.owner.exactTiles || [],
    file: report.file,
    bytes: report.bytes,
    sha256: report.sha256
  }))
  .sort((left, right) =>
    left.prefix.z - right.prefix.z ||
    left.prefix.x - right.prefix.x ||
    left.prefix.y - right.prefix.y
  );
const complete = owners.length === plan.plannedOwnerCount;
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  planVersion: plan.planVersion,
  browserSourceId: 'occumed-open',
  minZoom: 0,
  maxZoom: 16,
  complete,
  validationFixture: !complete,
  logicalOwnerCount: plan.logicalOwnerCount,
  plannedOwnerCount: plan.plannedOwnerCount,
  builtOwnerCount: owners.length,
  defaultOwner: foundation.id,
  totalBytes: foundation.bytes + owners.reduce((sum, owner) => sum + owner.bytes, 0),
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
if (options['asset-base-url']) manifest.assetBaseUrl = options['asset-base-url'];
manifest.artifactVersion = computeImmutableArtifactVersion(manifest);
validateImmutableManifest(manifest, { allowPartial: !complete });

const outputPath = path.resolve(options.output);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const pending = `${outputPath}.pending-${process.pid}`;
await fs.writeFile(pending, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
await fs.rename(pending, outputPath);
console.log(
  `Finalized immutable manifest ${manifest.artifactVersion}: ${owners.length} of ` +
  `${plan.plannedOwnerCount} owners, ${manifest.totalBytes} bytes.`
);
