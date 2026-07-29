#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { PMTiles, SharedPromiseCache } from 'pmtiles';
import { mergeVectorTiles } from '../src/server/mvt.js';
import { RetryingFetchSource } from '../src/server/pmtiles-source.js';
import { WorldTileRoutingIndex } from '../src/server/world-tile-routing.js';

const MIN_NAVIGATION_MAX_ZOOM = 6;

function parseArgs(argv) {
  const options = {
    maxZoom: MIN_NAVIGATION_MAX_ZOOM,
    concurrency: 24
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--manifest') options.manifest = argv[++index];
    else if (key === '--release-base') options.releaseBase = argv[++index];
    else if (key === '--output') options.output = argv[++index];
    else if (key === '--maxzoom') options.maxZoom = Number(argv[++index]);
    else if (key === '--concurrency') options.concurrency = Number(argv[++index]);
  }
  for (const required of ['manifest', 'releaseBase', 'output']) {
    if (!options[required]) throw new Error(`Missing --${required}.`);
  }
  if (!Number.isSafeInteger(options.maxZoom) || options.maxZoom < 0 || options.maxZoom > 8) {
    throw new Error('--maxzoom must be an integer between 0 and 8.');
  }
  if (options.maxZoom < MIN_NAVIGATION_MAX_ZOOM) {
    console.warn(
      `Requested overview max zoom ${options.maxZoom} is unsafe for reverse navigation; ` +
      `building through zoom ${MIN_NAVIGATION_MAX_ZOOM} instead.`
    );
    options.maxZoom = MIN_NAVIGATION_MAX_ZOOM;
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 64) {
    throw new Error('--concurrency must be an integer between 1 and 64.');
  }
  return options;
}

async function mapLimit(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}

const options = parseArgs(process.argv.slice(2));
const manifestResponse = await fetch(options.manifest, {
  headers: { 'User-Agent': 'Occu-Med-Map/world-overview-builder' },
  redirect: 'follow'
});
if (!manifestResponse.ok) {
  throw new Error(`Unable to load worldwide manifest (${manifestResponse.status}).`);
}

const manifest = await manifestResponse.json();
if (!Array.isArray(manifest.regions) || !manifest.regions.length) {
  throw new Error('Worldwide manifest has no regional archives.');
}

await fs.rm(options.output, { recursive: true, force: true });
await fs.mkdir(options.output, { recursive: true });

const routing = new WorldTileRoutingIndex(manifest.regions, {
  routingZoom: manifest.virtualTiles?.routingZoom || 6
});
const directoryCache = new SharedPromiseCache(8192);
const archives = new Map();
const releaseBase = options.releaseBase.replace(/\/$/, '');

function archive(region) {
  let instance = archives.get(region.asset);
  if (!instance) {
    instance = new PMTiles(
      new RetryingFetchSource(
        `${releaseBase}/${encodeURIComponent(region.asset)}`,
        { attempts: 5, timeoutMs: 30_000 }
      ),
      directoryCache
    );
    archives.set(region.asset, instance);
  }
  return instance;
}

let writtenTiles = 0;
let sourceTileReads = 0;
for (let zoom = 0; zoom <= options.maxZoom; zoom += 1) {
  const count = 2 ** zoom;
  for (let x = 0; x < count; x += 1) {
    for (let y = 0; y < count; y += 1) {
      const regions = routing.regionsForTile(zoom, x, y);
      const payloads = await mapLimit(regions, options.concurrency, async (region) => {
        try {
          const result = await archive(region).getZxy(zoom, x, y);
          sourceTileReads += 1;
          return result?.data ? Buffer.from(result.data) : null;
        } catch (error) {
          throw new Error(
            `Unable to read ${region.id} (${region.asset}) at ${zoom}/${x}/${y}: ${error.message}`,
            { cause: error }
          );
        }
      });
      const merged = mergeVectorTiles(payloads);
      if (!merged.byteLength) continue;

      const directory = path.join(options.output, String(zoom), String(x));
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${y}.pbf`), merged);
      writtenTiles += 1;
    }
  }
  console.log(
    `Overview zoom ${zoom}: ${writtenTiles} merged tiles written from ${sourceTileReads} shard tile reads.`
  );
}

const metadataRegion = manifest.regions[0];
const metadata = await archive(metadataRegion).getMetadata();
await fs.writeFile(
  path.join(options.output, 'metadata.json'),
  `${JSON.stringify({
    name: 'Occu-Med Worldwide Navigation Overview',
    description: 'Consolidated coarse-navigation tiles from the Occu-Med regional storage shards',
    version: '2',
    type: 'baselayer',
    format: 'pbf',
    minzoom: 0,
    maxzoom: options.maxZoom,
    bounds: '-180,-85.0511288,180,85.0511288',
    center: `0,0,${Math.min(2, options.maxZoom)}`,
    vector_layers: metadata.vector_layers || []
  }, null, 2)}\n`
);

console.log(
  `Worldwide navigation overview complete: ${writtenTiles} tiles, ${sourceTileReads} shard reads, zoom 0-${options.maxZoom}.`
);
