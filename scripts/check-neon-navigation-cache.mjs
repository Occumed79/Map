import assert from 'node:assert/strict';
import {
  collectNavigationDatabaseUrls,
  navigationTileShardIndex,
  NeonNavigationTileCache
} from '../src/server/neon-navigation-tile-cache.js';

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

console.log('Neon navigation cache validated: deterministic sharding, z0-6 bounds, fail-safe configuration, and secret-free health output.');
