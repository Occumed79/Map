import assert from 'node:assert/strict';
import {
  collectNavigationDatabaseUrls,
  navigationTileShardIndex,
  NeonNavigationTileCache
} from '../src/server/neon-navigation-tile-cache.js';
import { WorldTileGateway } from '../src/server/world-tile-gateway.js';

const urls = collectNavigationDatabaseUrls({
  NAV_DATABASE_URL_1: 'postgresql://one:secret@one.example/neondb?sslmode=require',
  NAV_DATABASE_URL_2: 'not-a-database-url',
  NAV_DATABASE_URL_3: 'postgresql://two:secret@two.example/neondb?sslmode=require',
  NAV_DATABASE_URL_4: 'postgresql://one:secret@one.example/neondb?sslmode=require'
});
assert.deepEqual(urls.map(({ slot }) => slot), [1, 3]);
assert.equal(navigationTileShardIndex('version/6/32/20', 8), navigationTileShardIndex('version/6/32/20', 8));
assert.equal(navigationTileShardIndex('version/6/32/20', 0), -1);

const calls = [];
const closed = [];
const cache = new NeonNavigationTileCache(urls, {
  shardFactory: ({ slot }) => ({
    async initialize() {
      calls.push(['initialize', slot]);
      return true;
    },
    async get(version, zoom, x, y) {
      calls.push(['get', slot, version, zoom, x, y]);
      return Buffer.from(`tile-${slot}`);
    },
    async set(version, zoom, x, y, value) {
      calls.push(['set', slot, version, zoom, x, y, Buffer.from(value).toString()]);
      return true;
    },
    async close() {
      closed.push(slot);
    },
    snapshot() {
      return { slot, initialized: true };
    }
  })
});

assert.equal(await cache.initialize(), 2);
const tile = await cache.get('manifest-a', 6, 32, 20);
assert.match(tile.toString(), /^tile-(?:1|3)$/);
assert.equal(await cache.set('manifest-a', 6, 32, 20, Buffer.from('payload')), true);
const routedOperations = calls.filter(([operation]) => operation === 'get' || operation === 'set');
assert.equal(routedOperations.length, 2);
assert.equal(routedOperations[0][1], routedOperations[1][1]);

const beforeAboveMax = calls.length;
assert.equal(await cache.get('manifest-a', 7, 64, 40), null);
assert.equal(await cache.set('manifest-a', 7, 64, 40, Buffer.from('ignored')), false);
assert.equal(calls.length, beforeAboveMax);

const snapshot = cache.snapshot();
assert.equal(snapshot.enabled, true);
assert.equal(snapshot.configuredShards, 2);
assert.equal(snapshot.expectedShards, 8);
assert.equal(snapshot.maxZoom, 6);
assert.equal(JSON.stringify(snapshot).includes('secret'), false);

await cache.close();
assert.deepEqual(closed.sort((a, b) => a - b), [1, 3]);

const manifest = {
  version: 2,
  plannedRegionCount: 1,
  availableRegionCount: 1,
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
    {
      id: 'test-region',
      asset: 'occumed-test-region.pmtiles',
      bounds: [-180, -90, 180, 90]
    }
  ]
};
const persistentCalls = [];
const persistentCache = {
  async initialize() {
    persistentCalls.push(['initialize']);
    return 1;
  },
  async get(version, zoom, x, y) {
    persistentCalls.push(['get', version, zoom, x, y]);
    return zoom === 0 ? Buffer.from([0x1a, 0x00]) : null;
  },
  async set(version, zoom, x, y, value) {
    persistentCalls.push(['set', version, zoom, x, y, Buffer.from(value).toString('hex')]);
    return true;
  },
  async close() {
    persistentCalls.push(['close']);
  },
  snapshot() {
    return { enabled: true, configuredShards: 1 };
  }
};
const gateway = new WorldTileGateway({
  manifestUrl: 'https://example.test/world-virtual-manifest.json',
  releaseAssetUrl: (asset) => `https://example.test/${asset}`,
  persistentTileCache,
  fetchImpl: async () => new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
});
let builds = 0;
gateway.buildTile = async () => {
  builds += 1;
  return Buffer.from([0x1a, 0x01, 0x00]);
};

assert.equal(await gateway.initializePersistentCache(), 1);
const persistentHit = await gateway.resolveTile(0, 0, 0);
assert.equal(persistentHit.toString('hex'), '1a00');
assert.equal(builds, 0);
const persistentGetsAfterFirst = persistentCalls.filter(([operation]) => operation === 'get').length;
const memoryHit = await gateway.resolveTile(0, 0, 0);
assert.equal(memoryHit.toString('hex'), '1a00');
assert.equal(persistentCalls.filter(([operation]) => operation === 'get').length, persistentGetsAfterFirst);

const builtTile = await gateway.resolveTile(1, 0, 0);
assert.equal(builtTile.toString('hex'), '1a0100');
assert.equal(builds, 1);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(persistentCalls.some(([operation]) => operation === 'set'), true);
assert.equal(gateway.getHealthSnapshot().persistentCache.enabled, true);
await gateway.close();
assert.equal(persistentCalls.some(([operation]) => operation === 'close'), true);

console.log('Neon navigation cache validated: deterministic sharding, memory-first reads, z0-6 persistence, bounded fallback behavior, and secret-free health output.');
