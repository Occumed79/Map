import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST?.trim() || '0.0.0.0';

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

function requestOrigin(request) {
  const configured = process.env.PUBLIC_ORIGIN?.trim().replace(/\/$/, '');
  if (configured) return configured;

  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProtocol || 'http';
  const requestHost = forwardedHost || request.headers.host || `localhost:${port}`;
  return `${protocol}://${requestHost}`;
}

function send(response, status, body, contentType, cacheControl = 'no-store', method = 'GET') {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Pragma',
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': cacheControl,
    'Surrogate-Control': cacheControl,
    'Content-Type': contentType,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff'
  });
  if (method === 'HEAD') response.end();
  else response.end(body);
}

function sendHealth(request, response) {
  const body = 'ok';
  response.statusCode = 200;
  response.shouldKeepAlive = false;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Connection', 'close');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'HEAD') response.end();
  else response.end(body);
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

async function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requested);
  const absolute = path.resolve(root, `.${decoded}`);

  if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== path.join(root, 'index.html')) {
    send(response, 403, 'Forbidden', 'text/plain; charset=utf-8', 'no-store', request.method);
    return;
  }

  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Not a file');
    const body = await fs.readFile(absolute);
    const extension = path.extname(absolute).toLowerCase();
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

async function handleRequest(request, response) {
  const method = request.method || 'GET';

  if (method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Pragma',
      'Cache-Control': 'no-store'
    });
    response.end();
    return;
  }

  if (!['GET', 'HEAD'].includes(method)) {
    send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8', 'no-store', method);
    return;
  }

  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/style/occumed-open.json') {
    await serveStyle(request, response);
    return;
  }

  await serveStatic(request, response, url.pathname);
}

const server = http.createServer((request, response) => {
  const rawPath = (request.url || '/').split('?', 1)[0];

  // Keep Render's deployment probe completely independent from URL parsing,
  // filesystem access, the built map assets, and all application routing.
  if (rawPath === '/health' || rawPath === '/healthz') {
    sendHealth(request, response);
    return;
  }

  void handleRequest(request, response).catch((error) => {
    console.error(error);
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

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;

server.on('error', (error) => {
  console.error('Occu-Med Map server error:', error);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Occu-Med Map listening on ${host}:${port}.`);
  console.log(`Health endpoint ready at http://127.0.0.1:${port}/health.`);
});
