import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST?.trim() || '0.0.0.0';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const commonHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Cache-Control',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN'
};

function write(response, status, body, contentType = 'text/plain; charset=utf-8', method = 'GET', cacheControl = 'no-store') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  response.writeHead(status, {
    ...commonHeaders,
    'Cache-Control': cacheControl,
    'Content-Length': payload.byteLength,
    'Content-Type': contentType
  });
  if (method === 'HEAD') response.end();
  else response.end(payload);
}

function writeJson(response, status, value, method = 'GET') {
  write(response, status, `${JSON.stringify(value)}\n`, contentTypes['.json'], method);
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
    write(response, 400, 'Invalid URL encoding', undefined, request.method);
    return;
  }

  if (decoded.includes('\0')) {
    write(response, 400, 'Invalid path', undefined, request.method);
    return;
  }

  const absolute = path.resolve(publicRoot, `.${decoded}`);
  if (!absolute.startsWith(`${publicRoot}${path.sep}`) && absolute !== path.join(publicRoot, 'index.html')) {
    write(response, 403, 'Forbidden', undefined, request.method);
    return;
  }

  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Not a file');
    const extension = path.extname(absolute).toLowerCase();
    const body = await fs.readFile(absolute);
    const immutable = decoded.startsWith('/assets/');
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
      write(response, 404, 'Not found', undefined, request.method);
      return;
    }
    try {
      const index = await fs.readFile(path.join(publicRoot, 'index.html'));
      write(response, 200, index, contentTypes['.html'], request.method, 'no-store, max-age=0');
    } catch {
      write(response, 503, 'Application build unavailable', undefined, request.method);
    }
  }
}

let shuttingDown = false;

const server = http.createServer((request, response) => {
  void (async () => {
    const method = request.method || 'GET';
    if (method === 'OPTIONS') {
      response.writeHead(204, { ...commonHeaders, 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (!['GET', 'HEAD'].includes(method)) {
      write(response, 405, 'Method not allowed', undefined, method);
      return;
    }
    if (shuttingDown) {
      write(response, 503, 'Server is shutting down', undefined, method);
      return;
    }

    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      write(response, 200, 'ok', undefined, method);
      return;
    }
    if (url.pathname === '/readyz') {
      writeJson(response, 200, {
        ready: true,
        mode: 'clean-worldwide-vector-v2',
        projection: 'mercator',
        sourceCount: 1,
        runtimeMerging: false,
        neon: false,
        regionalRouting: false,
        shuttingDown
      }, method);
      return;
    }

    await serveStatic(request, response, url.pathname);
  })().catch((error) => {
    console.error('Request failed:', error);
    if (!response.headersSent) write(response, 500, 'Internal server error', undefined, request.method);
    else response.destroy();
  });
});

server.requestTimeout = 45_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Map v2 server received ${signal}; draining connections.`);
  server.close(() => process.exit(0));
  const timer = setTimeout(() => server.closeAllConnections?.(), 15_000);
  timer.unref?.();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(port, host, () => {
  console.log(`Occu-Med clean worldwide map v2 listening on ${host}:${port}.`);
  console.log('No PMTiles localization, Neon cache, regional routing, or runtime tile merging is active.');
});
