import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { validateVectorTilePayload } from '../src/server/tile-safety.js';

const origin = new URL(process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173');
const outputPath = path.resolve(
  process.env.OCCUMED_SOAK_OUTPUT || 'continuous-motion/world-soak-report.json'
);
const concurrency = 24;
const waves = 3;

function request(pathname, {
  method = 'GET',
  headers = {},
  timeoutMs = 60_000
} = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const req = http.request({
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      path: pathname,
      method,
      timeout: timeoutMs,
      headers: {
        Host: origin.host,
        'X-Request-Id': `soak-${Math.random().toString(16).slice(2)}`,
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        pathname,
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        durationMs: performance.now() - startedAt
      }));
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${pathname} timed out.`)));
    req.on('error', reject);
    req.end();
  });
}

async function json(pathname) {
  const response = await request(pathname, { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200, `${pathname} returned ${response.status}.`);
  return JSON.parse(response.body.toString('utf8'));
}

function lonLatToTile(longitude, latitude, zoom) {
  const count = 2 ** zoom;
  const x = Math.min(count - 1, Math.max(0, Math.floor(((longitude + 180) / 360) * count)));
  const clampedLatitude = Math.min(85.05112878, Math.max(-85.05112878, latitude));
  const radians = clampedLatitude * Math.PI / 180;
  const y = Math.min(
    count - 1,
    Math.max(0, Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * count))
  );
  return `/tiles/${zoom}/${x}/${y}.pbf`;
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const before = await json('/internal/tile-health');
const readinessBefore = await json('/readyz');
assert.equal(readinessBefore.ready, true);

const centers = [
  { name: 'fresno', coordinates: [-119.7871, 36.7378] },
  { name: 'amazon', coordinates: [-60, -8] },
  { name: 'europe', coordinates: [12, 50] },
  { name: 'tokyo', coordinates: [139.6917, 35.6895] },
  { name: 'sydney', coordinates: [151.2093, -33.8688] },
  { name: 'cairo', coordinates: [31.2357, 30.0444] },
  { name: 'central-pacific', coordinates: [-140, 0] },
  { name: 'south-atlantic', coordinates: [-30, -30] },
  { name: 'antimeridian', coordinates: [179, 0] }
];
const zooms = [0, 2, 4, 5, 6, 7, 8, 10, 12, 14, 16];
const uniquePaths = [...new Set(
  centers.flatMap((center) =>
    zooms.map((zoom) => lonLatToTile(center.coordinates[0], center.coordinates[1], zoom))
  )
)];

const requests = [];
for (let wave = 0; wave < waves; wave += 1) {
  for (let index = 0; index < uniquePaths.length; index += 1) {
    requests.push({
      wave,
      pathname: uniquePaths[index],
      encoding: (wave + index) % 2 === 0 ? 'gzip' : 'identity'
    });
  }
}

const responses = await mapLimit(requests, concurrency, async (entry) => {
  const response = await request(entry.pathname, {
    headers: { 'Accept-Encoding': entry.encoding }
  });
  assert.equal(response.status, 200, `${entry.pathname} returned ${response.status}.`);
  assert.equal(response.headers['content-type'], 'application/x-protobuf');
  assert(response.headers.etag, `${entry.pathname} did not return an ETag.`);
  const tile = response.headers['content-encoding'] === 'gzip'
    ? gunzipSync(response.body)
    : response.body;
  validateVectorTilePayload(tile, { label: `soak ${entry.pathname}` });
  return {
    wave: entry.wave,
    pathname: entry.pathname,
    encoding: entry.encoding,
    durationMs: response.durationMs,
    encodedBytes: response.body.byteLength,
    decodedBytes: tile.byteLength,
    etag: response.headers.etag
  };
});

const etagsByPath = new Map();
for (const response of responses) {
  const previous = etagsByPath.get(response.pathname);
  if (previous) {
    assert.equal(response.etag, previous, `${response.pathname} changed ETag between soak waves.`);
  } else {
    etagsByPath.set(response.pathname, response.etag);
  }
}

const hotPath = lonLatToTile(-60, -8, 8);
const coalesced = await Promise.all(
  Array.from({ length: 64 }, () => request(hotPath, {
    headers: { 'Accept-Encoding': 'identity' }
  }))
);
assert.equal(new Set(coalesced.map((response) => response.headers.etag)).size, 1);
for (const response of coalesced) {
  assert.equal(response.status, 200);
  validateVectorTilePayload(response.body, { label: '64-request coalesced hot tile' });
}

await new Promise((resolve) => setTimeout(resolve, 250));
const after = await json('/internal/tile-health');
const readinessAfter = await json('/readyz');
const healthAfter = await request('/healthz');
assert.equal(healthAfter.status, 200);
assert.equal(readinessAfter.ready, true);
assert.equal(after.inflightTiles, 0, 'Gateway retained in-flight tile promises after the soak.');
assert.equal(after.archiveReads.active, 0, 'Archive reads remained active after the soak.');
assert.equal(after.archiveReads.queued, 0, 'Archive reads remained queued after the soak.');
assert(after.cache.bytes <= after.cache.maxBytes, 'Tile cache exceeded its configured byte budget.');
assert(after.cache.entries <= 8_192, 'Tile cache exceeded its entry budget.');
assert.equal(
  after.metrics.overloads,
  before.metrics.overloads,
  'The normal soak triggered gateway overload protection.'
);
assert.equal(
  after.metrics.failed,
  before.metrics.failed,
  'Valid worldwide soak requests produced gateway failures.'
);
for (const source of after.sources) {
  assert.equal(source.circuitOpen, false, `${source.asset} left its upstream circuit open.`);
}

const durations = responses
  .map((response) => response.durationMs)
  .sort((left, right) => left - right);
const percentile = (fraction) => durations[
  Math.min(durations.length - 1, Math.floor(durations.length * fraction))
];
const report = {
  generatedAt: new Date().toISOString(),
  origin: origin.href,
  waves,
  concurrency,
  distinctTileCount: uniquePaths.length,
  totalTileRequests: responses.length + coalesced.length,
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  maximumMs: durations.at(-1),
  slowest: [...responses]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 30),
  before,
  after,
  passed: true
};
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

assert(report.p95Ms < 45_000, `Worldwide soak p95 was ${Math.round(report.p95Ms)}ms.`);
assert(report.maximumMs < 60_000, `Worldwide soak maximum was ${Math.round(report.maximumMs)}ms.`);
console.log(
  `Worldwide soak passed: ${report.totalTileRequests} requests, ${report.distinctTileCount} distinct tiles, zooms 0–16, p95 ${Math.round(report.p95Ms)}ms, zero failures, zero overloads, and all queues drained.`
);
