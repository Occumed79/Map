import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { validateVectorTilePayload } from '../src/server/tile-safety.js';

const origin = new URL(process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173');
const deadlineMs = Number(process.env.OCCUMED_HTTP_HARDENING_DEADLINE_MS || 90_000);

function request(pathname, {
  method = 'GET',
  headers = {},
  timeoutMs = 45_000
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
        'X-Request-Id': `hardening-${Math.random().toString(16).slice(2)}`,
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
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

async function waitForReadiness() {
  const deadline = Date.now() + deadlineMs;
  let last;
  while (Date.now() < deadline) {
    last = await request('/readyz', { timeoutMs: 12_000 }).catch((error) => ({
      status: 0,
      body: Buffer.from(error.message)
    }));
    if (last.status === 200) return last;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Candidate gateway never became ready: ${last?.status} ${last?.body?.toString('utf8')}`);
}

const health = await request('/healthz');
assert.equal(health.status, 200);
assert.equal(health.body.toString('utf8'), 'ok');
assert.equal(health.headers['x-content-type-options'], 'nosniff');
assert(health.headers['permissions-policy']?.includes('camera=()'));
assert(health.headers['x-occumed-request-id']);

const ready = await waitForReadiness();
const readyDocument = JSON.parse(ready.body.toString('utf8'));
assert.equal(readyDocument.ready, true);
assert.equal(readyDocument.shuttingDown, false);
assert(readyDocument.regions >= 700, `Readiness reported only ${readyDocument.regions} regions.`);

const plain = await request('/tiles/0/0/0.pbf', {
  headers: { 'Accept-Encoding': 'identity' }
});
assert.equal(plain.status, 200);
assert.equal(plain.headers['content-type'], 'application/x-protobuf');
assert.equal(plain.headers['x-occumed-tileset'], 'virtual-worldwide-v2');
assert.equal(plain.headers['content-encoding'], undefined);
assert(plain.headers.etag);
assert(plain.headers['server-timing']?.includes('tile;dur='));
assert(plain.headers['cache-control']?.includes('stale-if-error=86400'));
validateVectorTilePayload(plain.body, { label: 'plain HTTP globe tile' });

const gzip = await request('/tiles/0/0/0.pbf', {
  headers: { 'Accept-Encoding': 'gzip' }
});
assert.equal(gzip.status, 200);
assert.equal(gzip.headers['content-encoding'], 'gzip');
assert.equal(gzip.headers.etag, plain.headers.etag);
const uncompressed = gunzipSync(gzip.body);
assert(uncompressed.equals(plain.body), 'Gzip and identity responses do not contain the same vector tile.');

const notModified = await request('/tiles/0/0/0.pbf', {
  headers: {
    'Accept-Encoding': 'identity',
    'If-None-Match': plain.headers.etag
  }
});
assert.equal(notModified.status, 304);
assert.equal(notModified.body.length, 0);

const head = await request('/tiles/0/0/0.pbf', {
  method: 'HEAD',
  headers: { 'Accept-Encoding': 'identity' }
});
assert.equal(head.status, 200);
assert.equal(head.body.length, 0);
assert.equal(head.headers.etag, plain.headers.etag);

const invalidTile = await request('/tiles/17/0/0.pbf');
assert.equal(invalidTile.status, 404);
assert(!invalidTile.body.toString('utf8').includes('<!doctype html>'));

const invalidCoordinate = await request('/tiles/2/4/0.pbf');
assert.equal(invalidCoordinate.status, 404);

const missingAsset = await request('/assets/does-not-exist.pbf', {
  headers: { Accept: 'application/x-protobuf' }
});
assert.equal(missingAsset.status, 404);
assert(!missingAsset.body.toString('utf8').includes('<!doctype html>'));

const invalidMethod = await request('/tiles/0/0/0.pbf', { method: 'POST' });
assert.equal(invalidMethod.status, 405);
assert.equal(invalidMethod.headers.allow, 'GET, HEAD, OPTIONS');

const sameTileBurst = await Promise.all(
  Array.from({ length: 24 }, () => request('/tiles/2/1/1.pbf', {
    headers: { 'Accept-Encoding': 'identity' }
  }))
);
for (const response of sameTileBurst) {
  assert.equal(response.status, 200);
  assert(response.headers.etag);
  validateVectorTilePayload(response.body, { label: 'coalesced burst tile' });
}
assert.equal(
  new Set(sameTileBurst.map((response) => response.headers.etag)).size,
  1,
  'Concurrent requests for one tile did not resolve deterministically.'
);

const worldTiles = [];
for (let y = 0; y < 4; y += 1) {
  for (let x = 0; x < 4; x += 1) worldTiles.push(`/tiles/2/${x}/${y}.pbf`);
}
const distinctBurst = await Promise.all(
  worldTiles.map((pathname) => request(pathname, {
    headers: { 'Accept-Encoding': 'identity' }
  }))
);
for (let index = 0; index < distinctBurst.length; index += 1) {
  const response = distinctBurst[index];
  assert.equal(response.status, 200, `${worldTiles[index]} returned ${response.status}.`);
  validateVectorTilePayload(response.body, { label: worldTiles[index] });
}

const durations = [...sameTileBurst, ...distinctBurst]
  .map((response) => response.durationMs)
  .sort((left, right) => left - right);
const p95 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
assert(p95 < 45_000, `Candidate HTTP p95 exceeded the request deadline: ${Math.round(p95)}ms.`);

console.log(
  `HTTP hardening passed: readiness, security headers, identity/gzip parity, ETag 304, HEAD, strict 404/405 handling, 24-request coalescing, 16 distinct world tiles, and p95 ${Math.round(p95)}ms.`
);
