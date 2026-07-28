import assert from 'node:assert/strict';
import vtpbf from 'vt-pbf';
import { RetryingFetchSource } from '../src/server/pmtiles-source.js';
import {
  MemoryTileCache,
  parseManifest,
  WorldTileGateway
} from '../src/server/world-tile-gateway.js';
import { validateVectorTilePayload } from '../src/server/tile-safety.js';
import { WorldTileRoutingIndex } from '../src/server/world-tile-routing.js';

function vectorTile() {
  return Buffer.from(vtpbf.fromGeojsonVt({
    land: {
      features: [{
        id: 1,
        type: 3,
        geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]],
        tags: {}
      }]
    }
  }));
}

const validTile = vectorTile();
const validInspection = validateVectorTilePayload(validTile, { label: 'valid test tile' });
assert.equal(validInspection.layerCount, 1);
assert.equal(validInspection.featureCount, 1);
assert.throws(
  () => validateVectorTilePayload(Buffer.from([0xff, 0xff, 0xff]), { label: 'corrupt test tile' }),
  /valid Mapbox Vector Tile/
);
assert.throws(
  () => validateVectorTilePayload(Buffer.alloc(2_048), { maxBytes: 1_024 }),
  /unsafe encoded size/
);

let transientCalls = 0;
const transientSource = {
  getKey: () => 'transient-source',
  getBytes: async () => {
    transientCalls += 1;
    if (transientCalls < 3) {
      const error = new Error('HTTP status 503');
      error.status = 503;
      throw error;
    }
    return { data: new Uint8Array([1, 2, 3]) };
  }
};
const retrying = new RetryingFetchSource('https://example.test/map.pmtiles', {
  source: transientSource,
  attempts: 3,
  baseDelayMs: 0,
  maxDelayMs: 0,
  random: () => 0
});
await retrying.getBytes(0, 3);
assert.equal(transientCalls, 3, 'Transient upstream failures were not retried exactly as bounded.');
assert.equal(retrying.getHealthSnapshot().totalRetries, 2);

let permanentCalls = 0;
const permanentSource = {
  getKey: () => 'permanent-source',
  getBytes: async () => {
    permanentCalls += 1;
    const error = new Error('HTTP status 404');
    error.status = 404;
    throw error;
  }
};
const permanent = new RetryingFetchSource('https://example.test/missing.pmtiles', {
  source: permanentSource,
  attempts: 4,
  baseDelayMs: 0,
  maxDelayMs: 0
});
await assert.rejects(() => permanent.getBytes(0, 10), /bounded retries/);
assert.equal(permanentCalls, 1, 'Permanent 4xx failures were retried.');
await assert.rejects(() => permanent.getBytes(0, 100_000_000), /range length/);

let clock = 1_000;
const cache = new MemoryTileCache(2 * 1024 * 1024, {
  ttlMs: 1_000,
  staleMs: 5_000,
  now: () => clock
});
cache.set('0/0/0', validTile);
assert(cache.getFresh('0/0/0'));
clock = 2_500;
assert.equal(cache.getFresh('0/0/0'), null);
assert(cache.getStale('0/0/0'));
clock = 7_000;
assert.equal(cache.getStale('0/0/0'), null);

const manifest = {
  version: 2,
  plannedRegionCount: 2,
  availableRegionCount: 2,
  missingRegionCount: 0,
  virtualTiles: {
    endpoint: '/tiles/{z}/{x}/{y}.pbf',
    overviewAsset: 'occumed-world-overview.pmtiles',
    surfaceAsset: 'occumed-world-surface.pmtiles',
    overviewMaxZoom: 5,
    surfaceMaxZoom: 10,
    routingZoom: 6,
    maxZoom: 16
  },
  regions: [
    { id: 'west', asset: 'occumed-west.pmtiles', bounds: [-20, -10, 1, 10] },
    { id: 'east', asset: 'occumed-east.pmtiles', bounds: [0, -10, 20, 10] }
  ]
};
const parsed = parseManifest(manifest);
assert.equal(parsed.regions.length, 2);
assert.throws(
  () => parseManifest({
    ...manifest,
    regions: [manifest.regions[0], { ...manifest.regions[1], id: 'west' }]
  }),
  /repeats regional ID/
);
assert.throws(
  () => parseManifest({
    ...manifest,
    virtualTiles: { ...manifest.virtualTiles, routingZoom: 8 }
  }),
  /exactly adjacent/
);
assert.throws(
  () => new WorldTileRoutingIndex(parsed.regions, { routingZoom: 6, maxCellFanout: 1 }),
  /fan-out limit/
);

clock = 10_000;
const gateway = new WorldTileGateway({
  manifestUrl: 'https://example.test/world-manifest.json',
  releaseAssetUrl: (asset) => `https://example.test/${asset}`,
  cacheTtlMs: 1_000,
  cacheStaleMs: 10_000,
  now: () => clock
});
gateway.loadManifest = async () => parsed;
let buildFails = false;
gateway.buildTile = async () => {
  if (buildFails) throw new Error('simulated upstream outage');
  return validTile;
};
const first = await gateway.resolveTile(0, 0, 0);
assert(first.equals(validTile));
clock = 12_000;
buildFails = true;
const stale = await gateway.resolveTile(0, 0, 0);
assert(stale.equals(validTile), 'A last-known-good tile was not served during an upstream outage.');
assert.equal(gateway.getHealthSnapshot().metrics.staleServed, 1);

console.log('Worldwide hardening validated: bounded retries, permanent-failure classification, circuit-safe ranges, MVT budgets, strict manifests, fan-out limits, cache expiry, and stale-tile recovery.');
