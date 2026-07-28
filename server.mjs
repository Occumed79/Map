import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzip } from 'node:zlib';
import {
  GatewayOverloadedError,
  WorldTileGateway
} from './src/server/world-tile-gateway.js';
import { normalizeTileCoordinates } from './src/server/world-tile-routing.js';
import { validateVectorTilePayload } from './src/server/tile-safety.js';

const gzipAsync = promisify(gzip);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST?.trim() || '0.0.0.0';
const worldReleaseRepository = process.env.OCCUMED_WORLD_RELEASE_REPOSITORY?.trim() || 'Occumed79/Map';
const worldReleaseTag = process.env.OCCUMED_WORLD_RELEASE_TAG?.trim() || 'occumed-world-v1';
const worldManifestAsset = 'world-virtual-manifest.json';
const worldSurfaceAsset = 'occumed-world-surface.pmtiles';
const worldSurfaceUrl = process.env.OCCUMED_WORLD_SURFACE_URL?.trim();
const maxConcurrentTileRequests = Number(process.env.OCCUMED_MAX_CONCURRENT_TILE_REQUESTS || 64);
const tileRequestTimeoutMs = Number(process.env.OCCUMED_TILE_REQUEST_TIMEOUT_MS || 30_000);
const maxResolvedTileBytes = Number(process.env.OCCUMED_MAX_RESOLVED_TILE_BYTES || 24 * 1024 * 1024);
const diagnosticsEnabled = process.env.OCCUMED_ENABLE_DIAGNOSTICS === 'true';
let activeTileRequests = 0;
let shuttingDown = false;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pbf': 'application/x-protobuf',
  '.pmtiles': 'application/vnd.pmtiles',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp'
};

const commonHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Pragma, Range, If-None-Match',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, ETag, Server-Timing, X-Occumed-Request-Id',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off'
};

function safeInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function sanitizeRequestId(value) {
  const requestId = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : randomUUID();
}

function resolveSafeOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function requestOrigin(request) {
  const configured = resolveSafeOrigin(process.env.PUBLIC_ORIGIN?.trim().replace(/\/$/, ''));
  if (configured) return configured;

  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = /^(?:http|https)$/.test(forwardedProtocol) ? forwardedProtocol : 'http';
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || String(request.headers.host || `localhost:${port}`).trim();
  return resolveSafeOrigin(`${protocol}://${requestHost}`) || `http://localhost:${port}`;
}

function bodyBuffer(body) {
  return Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
}

function writeHeaders(response, status, headers = {}) {
  response.writeHead(status, {
    ...commonHeaders,
    'X-Occumed-Request-Id': response.occumedRequestId,
    ...headers
  });
}

function send(response, status, body, contentType, cacheControl = 'no-store', method = 'GET', extraHeaders = {}) {
  const payload = bodyBuffer(body);
  writeHeaders(response, status, {
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': cacheControl,
    'Surrogate-Control': cacheControl,
    'Content-Length': payload.byteLength,
    'Content-Type': contentType,
    ...extraHeaders
  });
  if (method === 'HEAD' || status === 304) response.end();
  else response.end(payload);
}

function sendJson(response, status, document, cacheControl = 'no-store', method = 'GET', extraHeaders = {}) {
  send(
    response,
    status,
    `${JSON.stringify(document)}\n`,
    contentTypes['.json'],
    cacheControl,
    method,
    extraHeaders
  );
}

function sendHealth(request, response) {
  send(response, 200, 'ok', 'text/plain; charset=utf-8', 'no-store', request.method, {
    Connection: 'close'
  });
}

async function sendReadiness(request, response) {
  try {
    const ready = await Promise.race([
      worldTileGateway.ready(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Readiness check timed out.')), 10_000);
        timer.unref?.();
      })
    ]);
    sendJson(response, 200, { ...ready, shuttingDown }, 'no-store', request.method);
  } catch (error) {
    sendJson(response, 503, {
      ready: false,
      shuttingDown,
      error: error?.code || error?.name || 'READINESS_FAILED'
    }, 'no-store', request.method, { 'Retry-After': '5' });
  }
}

async function serveStyle(request, response) {
  const stylePath = path.join(root, 'style/occumed-open.json');
  const styleText = await fs.readFile(stylePath, 'utf8');
  const resolved = styleText.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', requestOrigin(request));
  send(
    response,
    200,
    resolved,
    contentTypes['.json'],
    'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    request.method
  );
}

function releaseAssetUrl(assetName) {
  if (assetName === worldSurfaceAsset && worldSurfaceUrl) return worldSurfaceUrl;
  return `https://github.com/${worldReleaseRepository}/releases/download/${encodeURIComponent(worldReleaseTag)}/${encodeURIComponent(assetName)}`;
}

const worldTileGateway = new WorldTileGateway({
  manifestUrl:
    process.env.OCCUMED_WORLD_MANIFEST_URL?.trim() ||
    releaseAssetUrl(worldManifestAsset),
  releaseAssetUrl,
  maxResolvedTileBytes: safeInteger(
    maxResolvedTileBytes,
    24 * 1024 * 1024,
    1_024,
    96 * 1024 * 1024
  )
});

function timeoutAfter(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message);
      error.code = 'OCCUMED_TILE_REQUEST_TIMEOUT';
      error.statusCode = 503;
      reject(error);
    }, milliseconds);
    timer.unref?.();
  });
}

function tileEtag(tile) {
  return `"${createHash('sha256').update(tile).digest('base64url').slice(0, 24)}"`;
}

async function serveVirtualTile(request, response, coordinates) {
  const concurrencyLimit = safeInteger(maxConcurrentTileRequests, 64, 4, 512);
  if (activeTileRequests >= concurrencyLimit) {
    throw new GatewayOverloadedError('The HTTP tile concurrency limit has been reached.');
  }

  activeTileRequests += 1;
  const startedAt = performance.now();
  try {
    const tile = await Promise.race([
      worldTileGateway.resolveTile(coordinates.z, coordinates.x, coordinates.y),
      timeoutAfter(
        safeInteger(tileRequestTimeoutMs, 30_000, 1_000, 120_000),
        `Tile ${coordinates.z}/${coordinates.x}/${coordinates.y} timed out.`
      )
    ]);
    validateVectorTilePayload(tile, {
      label: `resolved tile ${coordinates.z}/${coordinates.x}/${coordinates.y}`,
      maxBytes: safeInteger(maxResolvedTileBytes, 24 * 1024 * 1024, 1_024, 96 * 1024 * 1024)
    });

    const etag = tileEtag(tile);
    if (request.headers['if-none-match'] === etag) {
      writeHeaders(response, 304, {
        'Cache-Control': 'public, max-age=300, must-revalidate, stale-if-error=86400',
        ETag: etag,
        'X-Occumed-Tileset': 'virtual-worldwide-v2'
      });
      response.end();
      return;
    }

    const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(request.headers['accept-encoding'] || ''));
    const payload = acceptsGzip ? await gzipAsync(tile, { level: 5 }) : tile;
    const cacheControl = 'public, max-age=300, must-revalidate, stale-while-revalidate=60, stale-if-error=86400';
    const duration = Math.max(0, performance.now() - startedAt);

    writeHeaders(response, 200, {
      'Cache-Control': cacheControl,
      'CDN-Cache-Control': cacheControl,
      'Surrogate-Control': cacheControl,
      ...(acceptsGzip ? { 'Content-Encoding': 'gzip' } : {}),
      'Content-Length': payload.byteLength,
      'Content-Type': contentTypes['.pbf'],
      ETag: etag,
      'Server-Timing': `tile;dur=${duration.toFixed(1)}`,
      Vary: 'Accept-Encoding',
      'X-Occumed-Tileset': 'virtual-worldwide-v2'
    });
    if (request.method === 'HEAD') response.end();
    else response.end(payload);
  } finally {
    activeTileRequests -= 1;
  }
}

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;

  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return null;

  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function pipeFile(request, response, absolute, options = {}) {
  const stream = createReadStream(absolute, options);
  const abort = () => stream.destroy();
  request.once('aborted', abort);
  response.once('close', abort);
  stream.on('error', (error) => response.destroy(error));
  stream.on('close', () => {
    request.removeListener('aborted', abort);
    response.removeListener('close', abort);
  });
  stream.pipe(response);
}

async function servePmtiles(request, response, absolute, stat) {
  const cacheControl = 'public, max-age=3600, must-revalidate, stale-if-error=86400';
  const rangeHeader = request.headers.range;

  if (!rangeHeader) {
    writeHeaders(response, 200, {
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      'CDN-Cache-Control': cacheControl,
      'Surrogate-Control': cacheControl,
      'Content-Length': stat.size,
      'Content-Type': contentTypes['.pmtiles']
    });
    if (request.method === 'HEAD') response.end();
    else pipeFile(request, response, absolute);
    return;
  }

  const range = parseByteRange(rangeHeader, stat.size);
  if (!range) {
    send(
      response,
      416,
      'Requested range not satisfiable',
      'text/plain; charset=utf-8',
      'no-store',
      request.method,
      {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${stat.size}`
      }
    );
    return;
  }

  const length = range.end - range.start + 1;
  writeHeaders(response, 206, {
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': cacheControl,
    'Surrogate-Control': cacheControl,
    'Content-Length': length,
    'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
    'Content-Type': contentTypes['.pmtiles']
  });
  if (request.method === 'HEAD') response.end();
  else pipeFile(request, response, absolute, { start: range.start, end: range.end });
}

function shouldServeSpaFallback(request, decoded) {
  if (path.extname(decoded)) return false;
  return String(request.headers.accept || '').includes('text/html') || decoded === '/';
}

async function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    send(response, 400, 'Invalid URL encoding', 'text/plain; charset=utf-8', 'no-store', request.method);
    return;
  }
  if (decoded.includes('\0')) {
    send(response, 400, 'Invalid path', 'text/plain; charset=utf-8', 'no-store', request.method);
    return;
  }

  const absolute = path.resolve(root, `.${decoded}`);
  if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== path.join(root, 'index.html')) {
    send(response, 403, 'Forbidden', 'text/plain; charset=utf-8', 'no-store', request.method);
    return;
  }

  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Not a file');

    const extension = path.extname(absolute).toLowerCase();
    if (extension === '.pmtiles') {
      await servePmtiles(request, response, absolute, stat);
      return;
    }

    const body = await fs.readFile(absolute);
    const longLived = decoded.startsWith('/sprites/') || decoded.startsWith('/assets/');
    send(
      response,
      200,
      body,
      contentTypes[extension] || 'application/octet-stream',
      longLived ? 'public, max-age=31536000, immutable' : 'no-store, no-cache, must-revalidate, max-age=0',
      request.method
    );
  } catch {
    if (!shouldServeSpaFallback(request, decoded)) {
      send(response, 404, 'Not found', 'text/plain; charset=utf-8', 'no-store', request.method);
      return;
    }
    const index = await fs.readFile(path.join(root, 'index.html'));
    send(
      response,
      200,
      index,
      contentTypes['.html'],
      'no-store, no-cache, must-revalidate, max-age=0',
      request.method
    );
  }
}

function tileErrorStatus(error) {
  if (error instanceof GatewayOverloadedError) return 503;
  if (error instanceof RangeError) return 404;
  if (Number.isSafeInteger(error?.statusCode)) return error.statusCode;
  if (String(error?.code || '').startsWith('OCCUMED_')) return 503;
  return 500;
}

async function handleRequest(request, response) {
  const method = request.method || 'GET';
  if (method === 'OPTIONS') {
    writeHeaders(response, 204, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (!['GET', 'HEAD'].includes(method)) {
    send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8', 'no-store', method, {
      Allow: 'GET, HEAD, OPTIONS'
    });
    return;
  }
  if (shuttingDown) {
    send(response, 503, 'Server is shutting down', 'text/plain; charset=utf-8', 'no-store', method, {
      'Retry-After': '5'
    });
    return;
  }

  let url;
  try {
    url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  } catch {
    send(response, 400, 'Invalid request URL', 'text/plain; charset=utf-8', 'no-store', method);
    return;
  }

  if (url.pathname === '/readyz') {
    await sendReadiness(request, response);
    return;
  }
  if (url.pathname === '/internal/tile-health' && diagnosticsEnabled) {
    sendJson(response, 200, {
      activeTileRequests,
      ...worldTileGateway.getHealthSnapshot()
    }, 'no-store', method);
    return;
  }
  if (url.pathname === '/style/occumed-open.json') {
    await serveStyle(request, response);
    return;
  }

  const tileMatch = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname);
  if (tileMatch) {
    const coordinates = normalizeTileCoordinates(tileMatch[1], tileMatch[2], tileMatch[3]);
    if (!coordinates) {
      send(response, 404, 'Tile not found', 'text/plain; charset=utf-8', 'no-store', method);
      return;
    }
    try {
      await serveVirtualTile(request, response, coordinates);
    } catch (error) {
      const status = tileErrorStatus(error);
      console.error(JSON.stringify({
        level: 'error',
        type: 'tile-request-failed',
        requestId: response.occumedRequestId,
        tile: coordinates,
        code: error?.code || error?.name || 'UNKNOWN',
        message: error?.message || String(error)
      }));
      if (!response.headersSent) {
        send(
          response,
          status,
          status === 404 ? 'Tile not found' : 'Tile temporarily unavailable',
          'text/plain; charset=utf-8',
          'no-store',
          method,
          status === 503 ? { 'Retry-After': '2' } : {}
        );
      } else {
        response.destroy();
      }
    }
    return;
  }

  await serveStatic(request, response, url.pathname);
}

const server = http.createServer((request, response) => {
  response.occumedRequestId = sanitizeRequestId(request.headers['x-request-id']);
  const rawPath = (request.url || '/').split('?', 1)[0];

  if (rawPath === '/health' || rawPath === '/healthz') {
    sendHealth(request, response);
    return;
  }

  void handleRequest(request, response).catch((error) => {
    console.error(JSON.stringify({
      level: 'error',
      type: 'request-failed',
      requestId: response.occumedRequestId,
      code: error?.code || error?.name || 'UNKNOWN',
      message: error?.message || String(error)
    }));
    if (!response.headersSent) {
      send(
        response,
        500,
        'Internal server error',
        'text/plain; charset=utf-8',
        'no-store',
        request.method
      );
    } else {
      response.destroy();
    }
  });
});

server.requestTimeout = 45_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 1_000;

server.on('clientError', (error, socket) => {
  console.warn('Occu-Med Map client error:', error.code || error.message);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
server.on('error', (error) => {
  console.error('Occu-Med Map server error:', error);
  process.exitCode = 1;
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Occu-Med Map received ${signal}; draining connections.`);
  server.close((error) => {
    if (error) {
      console.error('Occu-Med Map shutdown error:', error);
      process.exitCode = 1;
    }
  });
  const timer = setTimeout(() => {
    server.closeAllConnections?.();
    process.exitCode = 1;
  }, 25_000);
  timer.unref?.();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(port, host, () => {
  console.log(`Occu-Med Map listening on ${host}:${port}.`);
  console.log(`Health endpoint ready at http://127.0.0.1:${port}/health.`);
  void worldTileGateway.ready().then(
    (ready) => console.log(`Worldwide gateway ready with ${ready.regions} regional shards.`),
    (error) => console.error('Worldwide gateway readiness failed:', error)
  );
});
