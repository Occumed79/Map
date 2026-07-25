import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || 4173);

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
  const host = forwardedHost || request.headers.host || `localhost:${port}`;
  return `${protocol}://${host}`;
}

function send(response, status, body, contentType, cacheControl = 'no-store') {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': cacheControl,
    'Content-Type': contentType,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff'
  });
  if (response.req.method === 'HEAD') response.end();
  else response.end(body);
}

async function serveStyle(request, response) {
  const stylePath = path.join(root, 'style/occumed-open.json');
  const styleText = await fs.readFile(stylePath, 'utf8');
  const resolved = styleText.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', requestOrigin(request));
  send(response, 200, resolved, contentTypes['.json'], 'public, max-age=300');
}

async function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requested);
  const absolute = path.resolve(root, `.${decoded}`);

  if (!absolute.startsWith(`${root}${path.sep}`) && absolute !== path.join(root, 'index.html')) {
    send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
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
      longLived ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
    );
  } catch {
    const index = await fs.readFile(path.join(root, 'index.html'));
    send(response, 200, index, contentTypes['.html'], 'no-store');
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      response.end();
      return;
    }

    if (!['GET', 'HEAD'].includes(request.method || '')) {
      send(response, 405, 'Method not allowed', 'text/plain; charset=utf-8');
      return;
    }

    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      send(
        response,
        200,
        JSON.stringify({ ok: true, service: 'occumed-map' }),
        contentTypes['.json'],
        'no-store'
      );
      return;
    }

    if (url.pathname === '/style/occumed-open.json') {
      await serveStyle(request, response);
      return;
    }

    await serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error(error);
    send(response, 500, 'Internal server error', 'text/plain; charset=utf-8');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Occu-Med Map listening on port ${port}.`);
});
