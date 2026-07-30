#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { zxyToTileId } from 'pmtiles';
import { compileImmutableTile } from './mvt-normalizer.mjs';
import { openPmtiles } from './local-pmtiles.mjs';
import { DeterministicPmtilesWriter } from './pmtiles-writer.mjs';

function parseArguments(argv) {
  const result = { regional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    const key = token.slice(2);
    if (key === 'regional') result.regional.push(value);
    else result[key] = value;
    index += 1;
  }
  for (const required of ['targets', 'overview', 'surface', 'output', 'report', 'workdir']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  return result;
}

function parseRegional(value) {
  const separator = value.indexOf('=');
  if (separator <= 0) throw new Error(`Regional input must be asset=location: ${value}`);
  return {
    assetName: value.slice(0, separator),
    location: value.slice(separator + 1)
  };
}

function displayLocation(value) {
  try {
    return path.basename(new URL(value).pathname);
  } catch {
    return path.basename(value);
  }
}

function mergeCounts(target, report) {
  for (const key of [
    'rejectedMalformed',
    'rejectedOversized',
    'rejectedTileFootprints',
    'removedExactDuplicates',
    'removedContainedOverlaps',
    'clippedEmpty'
  ]) {
    target[key] = (target[key] || 0) + Number(report[key] || 0);
  }
  for (const [layer, counts] of Object.entries(report.layers || {})) {
    target.layers[layer] ||= { featureCount: 0, pointCount: 0, tileCount: 0 };
    target.layers[layer].featureCount += Number(counts.featureCount || 0);
    target.layers[layer].pointCount += Number(counts.pointCount || 0);
    target.layers[layer].tileCount += 1;
  }
}

const options = parseArguments(process.argv.slice(2));
const targetDocument = JSON.parse(await fs.readFile(path.resolve(options.targets), 'utf8'));
const targetName = options['target-name'] || 'foundation';
const targets = targetDocument.targets?.[targetName] || targetDocument[targetName];
if (!Array.isArray(targets) || !targets.length) {
  throw new Error(`Target list is empty: ${targetName}`);
}
const ordered = [...targets]
  .map(({ z, x, y }) => ({ z: Number(z), x: Number(x), y: Number(y) }))
  .sort((left, right) =>
    zxyToTileId(left.z, left.x, left.y) - zxyToTileId(right.z, right.x, right.y)
  );
for (let index = 1; index < ordered.length; index += 1) {
  if (zxyToTileId(ordered[index - 1].z, ordered[index - 1].x, ordered[index - 1].y) ===
      zxyToTileId(ordered[index].z, ordered[index].x, ordered[index].y)) {
    throw new Error(`Duplicate target tile: ${ordered[index].z}/${ordered[index].x}/${ordered[index].y}`);
  }
}

const startedAt = performance.now();
const overview = await openPmtiles(options.overview, { cacheEntries: 4_096 });
const surface = await openPmtiles(options.surface, { cacheEntries: 4_096 });
const regional = [];
for (const input of options.regional.map(parseRegional)) {
  const opened = await openPmtiles(input.location, { cacheEntries: 4_096 });
  opened.assetName = input.assetName;
  regional.push(opened);
}
const writer = await new DeterministicPmtilesWriter({
  output: path.resolve(options.output),
  workDirectory: path.resolve(options.workdir),
  metadata: {
    name: `Occu-Med immutable owner ${targetName}`,
    type: 'baselayer',
    format: 'pbf',
    compression: 'gzip',
    authority_land: 'world-surface',
    authority_depth: 'world-surface',
    authority_landcover: 'world-overview',
    authority_cartography: 'regional-owner',
    runtime_merge: false,
    runtime_geometry: false
  }
}).initialize();

const aggregate = {
  rejectedMalformed: 0,
  rejectedOversized: 0,
  rejectedTileFootprints: 0,
  removedExactDuplicates: 0,
  removedContainedOverlaps: 0,
  clippedEmpty: 0,
  layers: {}
};
let completed = 0;
const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 4)));

try {
  for (let start = 0; start < ordered.length; start += concurrency) {
    const batch = ordered.slice(start, start + concurrency);
    const compiled = await Promise.all(
      batch.map((tile) => compileImmutableTile({
        ...tile,
        overview,
        surface,
        regional
      }))
    );
    for (let index = 0; index < batch.length; index += 1) {
      await writer.addTile({ ...batch[index], data: compiled[index].data });
      mergeCounts(aggregate, compiled[index].report);
      completed += 1;
    }
    if (completed % 250 === 0 || completed === ordered.length) {
      console.log(`[${targetName}] ${completed}/${ordered.length} tiles normalized.`);
    }
  }
  const finalized = await writer.finalize();
  const durationSeconds = (performance.now() - startedAt) / 1_000;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    targetName,
    file: options['manifest-file'] || path.basename(options.output),
    bytes: finalized.bytes,
    sha256: finalized.sha256,
    addressedTiles: finalized.addressedTiles,
    tileEntries: finalized.tileEntries,
    tileContents: finalized.tileContents,
    minZoom: finalized.minZoom,
    maxZoom: Number(options['foundation-max-zoom'] || finalized.maxZoom),
    durationSeconds,
    authorities: {
      land: 'world-surface',
      depth: 'world-surface',
      landcover: 'world-overview',
      cartography: 'regional-owner'
    },
    inputs: {
      overview: displayLocation(options.overview),
      surface: displayLocation(options.surface),
      regional: regional.map((opened) => opened.assetName)
    },
    normalization: aggregate
  };
  if (options['owner-id']) {
    const [z, x, y] = String(options['owner-prefix']).split('/').map(Number);
    const selectedOwner = targetDocument.selectedOwners?.find(
      (owner) => owner.id === options['owner-id']
    );
    report.owner = {
      id: options['owner-id'],
      prefix: { z, x, y },
      exactTiles: selectedOwner?.exactTiles || []
    };
  }
  const reportPath = path.resolve(options.report);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const pending = `${reportPath}.pending-${process.pid}`;
  await fs.writeFile(pending, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(pending, reportPath);
  console.log(
    `[${targetName}] built ${finalized.bytes} bytes in ${durationSeconds.toFixed(1)} seconds; ` +
    `SHA-256 ${finalized.sha256}.`
  );
} catch (error) {
  await writer.abort();
  throw error;
} finally {
  await Promise.allSettled([
    overview.close(),
    surface.close(),
    ...regional.map((opened) => opened.close())
  ]);
}
