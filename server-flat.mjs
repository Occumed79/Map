import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const publicRoot = path.join(repositoryRoot, 'dist');
const archivePath = path.join(publicRoot, 'virtual-assets', 'occumed-world-overview.pmtiles');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST?.trim() || '0.0.0.0';
const configuredMaxZoom = Number(process.env.OCCUMED_FLAT_MAX_ZOOM || 5);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pbf': 'application/x-protobuf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp'
};

const commonHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, If-None-Match',
  'Access-Control-Expose-Headers': 'Content-Length, ETag, X-Occumed-Request-Id, X-Occumed-Tileset',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff'
};

class LocalPmtilesSource {
  constructor(filename) {
    this.filename = filename;
    this.handlePromise = fs.open(filename, 'r');
  }

  getKey() {
    return this.filename;
  }

  async getBytes(offset, length) {
    const handle = await this.handlePromise;
    const requestedLength = Number(length);
    const requestedOffset = Number(offset);
    if (!Number.isSafeInteger(requestedLength) || requestedLength < 0) {
      throw new RangeError('Invalid PMTiles byte length.');
    }
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) {
      throw new RangeError('Invalid PMTiles byte offset.');
    }

    const buffer = Buffer.allocUnsafe(requestedLength);
    const { bytesRead } = await handle.read(buffer, 0, requestedLength, requestedOffset);
    if (bytesRead !== requestedLength) {
      throw new Error(`PMTiles short read: requested ${requestedLength}, received ${bytesRead}.`);
    }
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  }

  async close() {
    const handle = await this.handlePromise;
    await handle.close();
  }
}

function requestId(value) {
  const candidate = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) ? candidate : randomUUID();
}

function safeOrigin(request) {
  const configured = process.env.PUBLIC_ORIGIN?.trim().replace(/\/$/, '');
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        return parsed.origin;
      }
    } catch {
      // Fall through to request-derived origin.
    }
  }

  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = /^(?:http|https)$/.test(forwardedProtocol) ? forwardedProtocol : 'http';
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || String(request.headers.host || `localhost:${port}`).trim();
  return `${protocol}://${requestHost}`;
}

function write(response, status, body, contentType, method = 'GET', cacheControl = 'no-store', extra = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  response.writeHead(status, {
    ...commonHeaders,
    'X-Occumed-Request-Id': response.occumedRequestId,
    'Cache-Control': cacheControl,
    'Content-Length': payload.byteLength,
    'Content-Type': contentType,
    ...extra
  });
  if (method === 'HEAD' || status === 304) response.end();
  else response.end(payload);
}

function writeJson(response, status, value, method = 'GET', extra = {}) {
  write(response, status, `${JSON.stringify(value)}\n`, contentTypes['.json'], method, 'no-store', extra);
}

function normalizeCoordinates(zText, xText, yText, maxZoom) {
  const z = Number(zText);
  const x = Number(xText);
  const y = Number(yText);
  if (![z, x, y].every(Number.isSafeInteger)) return null;
  if (z < 0 || z > maxZoom) return null;
  const width = 2 ** z;
  if (x < 0 || x >= width || y < 0 || y >= width) return null;
  return { z, x, y };
}

function shouldServeSpa(request, pathname) {
  return pathname === '/' || (!path.extname(pathname) && String(request.headers.accept || '').includes('text/html'));
}

async function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    write(response, 400, 'Invalid URL encoding', 'text/plain; charset=utf-8', request.method);
    return;
  }

  if (decoded.includes('\0')) {
    write(response, 400, 'Invalid path', 'text/plain; charset=utf-8', request.method);
    return;
  }

  const absolute = path.resolve(publicRoot, `.${decoded}`);
  if (!absolute.startsWith(`${publicRoot}${path.sep}`) && absolute !== path.join(publicRoot, 'index.html')) {
    write(response, 403, 'Forbidden', 'text/plain; charset=utf-8', request.method);
    return;
  }

  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Not a file');
    const extension = path.extname(absolute).toLowerCase();
    const body = await fs.readFile(absolute);
    const immutable = decoded.startsWith('/assets/') || decoded.startsWith('/sprites/');
    write(
      response,
      200,
      body,
      contentTypes[extension] || 'application/octet-stream',
      request.method,
      immutable ? 'public, max-age=31536000, immutable' : 'no-store, max-age=0'
    );
  } catch {
    if (!shouldServeSpa(request, decoded)) {
      write(response, 404, 'Not found', 'text/plain; charset=utf-8', request.method);
      return;
    }
    const index = await fs.readFile(path.join(publicRoot, 'index.html'));
    write(response, 200, index, contentTypes['.html'], request.method, 'no-store, max-age=0');
  }
}

const source = new LocalPmtilesSource(archivePath);
const archive = new PMTiles(source);
const header = await archive.getHeader();
const maxZoom = Math.min(
  Number.isSafeInteger(configuredMaxZoom) ? configuredMaxZoom : 5,
  Number(header.maxZoom)
);

if (!Number.isSafeInteger(maxZoom) || maxZoom < 0) {
  throw new Error('The flat overview PMTiles archive has an invalid maximum zoom.');
}

let shuttingDown = false;
let activeRequests = 0;

async function handle(request, response) {
  const method = request.method || 'GET';
  if (method === 'OPTIONS') {
    response.writeHead(204, { ...commonHeaders, 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (!['GET', 'HEAD'].includes(method)) {
    write(response, 405, 'Method not allowed', 'text/plain; charset=utf-8', method, 'no-store', { Allow: 'GET, HEAD, OPTIONS' });
    return;
  }
  if (shuttingDown) {
    write(response, 503, 'Server is shutting down', 'text/plain; charset=utf-8', method, 'no-store', { 'Retry-After': '5' });
    return;
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/health' || url.pathname === '/healthz') {
    write(response, 200, 'ok', 'text/plain; charset=utf-8', method);
    return;
  }
  if (url.pathname === '/readyz') {
    writeJson(response, 200, {
      ready: true,
      mode: 'flat-overview-only',
      projection: 'mercator',
      minZoom: Number(header.minZoom),
      maxZoom,
      activeRequests,
      shuttingDown
    }, method);
    return;
  }
  if (url.pathname === '/style/occumed-open.json') {
    const styleText = await fs.readFile(path.join(publicRoot, 'style', 'occumed-open.json'), 'utf8');
    const resolved = styleText.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', safeOrigin(request));
    write(response, 200, resolved, contentTypes['.json'], method, 'no-store, max-age=0');
    return;
  }

  const tileMatch = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname);
  if (tileMatch) {
    const coordinates = normalizeCoordinates(tileMatch[1], tileMatch[2], tileMatch[3], maxZoom);
    if (!coordinates) {
      write(response, 404, 'Tile not found', 'text/plain; charset=utf-8', method);
      return;
    }

    activeRequests += 1;
    try {
      const result = await archive.getZxy(coordinates.z, coordinates.x, coordinates.y);
      if (!result?.data) {
        write(response, 204, Buffer.alloc(0), contentTypes['.pbf'], method, 'public, max-age=3600');
        return;
      }
      const tile = Buffer.from(result.data);
      const etag = `"${createHash('sha256').update(tile).digest('base64url').slice(0, 24)}"`;
      if (request.headers['if-none-match'] === etag) {
        write(response, 304, Buffer.alloc(0), contentTypes['.pbf'], method, 'public, max-age=3600', {
          ETag: etag,
          'X-Occumed-Tileset': 'flat-overview-only-v1'
        });
        return;
      }
      write(response, 200, tile, contentTypes['.pbf'], method, 'public, max-age=3600, stale-if-error=86400', {
        ETag: etag,
        'X-Occumed-Tileset': 'flat-overview-only-v1'
      });
    } finally {
      activeRequests -= 1;
    }
    return;
  }

  await serveStatic(request, response, url.pathname);
}

const server = http.createServer((request, response) => {
  response.occumedRequestId = requestId(request.headers['x-request-id']);
  void handle(request, response).catch((error) => {
    console.error(JSON.stringify({
      level: 'error',
      type: 'flat-request-failed',
      requestId: response.occumedRequestId,
      code: error?.code || error?.name || 'UNKNOWN',
      message: error?.message || String(error)
    }));
    if (!response.headersSent) {
      write(response, 500, 'Internal server error', 'text/plain; charset=utf-8', request.method);
    } else {
      response.destroy();
    }
  });
});

server.requestTimeout = 45_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Flat overview server received ${signal}; draining connections.`);
  server.close(() => {
    void source.close().catch((error) => console.error('Unable to close PMTiles source:', error));
  });
  const timer = setTimeout(() => server.closeAllConnections?.(), 20_000);
  timer.unref?.();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(port, host, () => {
  console.log(`Occu-Med flat overview server listening on ${host}:${port}.`);
  console.log(`Serving one immutable Mercator overview source through zoom ${maxZoom}; globe, Neon, and runtime tile synthesis are disabled.`);
});
