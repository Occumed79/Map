import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST?.trim() || '0.0.0.0';
const worldReleaseRepository = process.env.OCCUMED_WORLD_RELEASE_REPOSITORY?.trim() || 'Occumed79/Map';
const worldReleaseTag = process.env.OCCUMED_WORLD_RELEASE_TAG?.trim() || 'occumed-world-v1';
const worldManifestAsset = 'occumed-world-manifest.json';
const configuredUpstreamTimeout = Number(process.env.OCCUMED_UPSTREAM_TIMEOUT_MS || 20_000);
const upstreamTimeoutMs = Number.isFinite(configuredUpstreamTimeout)
  ? Math.max(configuredUpstreamTimeout, 1_000)
  : 20_000;

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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Pragma, Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff'
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
    ...corsHeaders,
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': cacheControl,
    'Surrogate-Control': cacheControl,
    'Content-Type': contentType
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

function releaseAssetUrl(assetName) {
  return `https://github.com/${worldReleaseRepository}/releases/download/${encodeURIComponent(worldReleaseTag)}/${encodeURIComponent(assetName)}`;
}

function copyUpstreamHeaders(upstream, response, cacheControl) {
  const headerNames = [
    'accept-ranges',
    'content-length',
    'content-range',
    'etag',
    'last-modified'
  ];
  for (const name of headerNames) {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  }
  response.setHeader('Cache-Control', cacheControl);
  response.setHeader('CDN-Cache-Control', cacheControl);
  response.setHeader('Surrogate-Control', cacheControl);
  for (const [name, value] of Object.entries(corsHeaders)) response.setHeader(name, value);
}

function createUpstreamContext(request, response) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Upstream request exceeded ${upstreamTimeoutMs}ms.`));
  }, upstreamTimeoutMs);
  timeout.unref?.();

  const abortForRequest = () => {
    controller.abort(new Error('Client disconnected before the upstream request completed.'));
  };
  const abortForResponse = () => {
    if (!response.writableFinished) abortForRequest();
  };

  request.once('aborted', abortForRequest);
  response.once('close', abortForResponse);

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      request.off('aborted', abortForRequest);
      response.off('close', abortForResponse);
    }
  };
}

function isUpstreamAbort(error, signal) {
  return Boolean(
    signal.aborted ||
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError' ||
    error?.code === 'ABORT_ERR'
  );
}

function handleUpstreamAbort(request, response, label) {
  if (request.aborted || response.destroyed) return;
  if (!response.headersSent) {
    send(
      response,
      504,
      `${label} upstream timed out`,
      'text/plain; charset=utf-8',
      'no-store',
      request.method
    );
  } else {
    response.destroy();
  }
}

async function proxyReleaseAsset(request, response, assetName, contentType, cacheControl) {
  const headers = {
    'User-Agent': 'Occu-Med-Map/world-pmtiles-proxy',
    Accept: '*/*'
  };
  if (request.headers.range) headers.Range = request.headers.range;

  const upstreamContext = createUpstreamContext(request, response);
  try {
    const upstream = await fetch(releaseAssetUrl(assetName), {
      method: request.method,
      headers,
      redirect: 'follow',
      signal: upstreamContext.signal
    });

    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 416) {
      send(
        response,
        upstream.status === 404 ? 404 : 502,
        upstream.status === 404 ? 'Worldwide map asset not built yet' : 'Worldwide map asset upstream failed',
        'text/plain; charset=utf-8',
        'no-store',
        request.method
      );
      return;
    }

    response.statusCode = upstream.status;
    copyUpstreamHeaders(upstream, response, cacheControl);
    response.setHeader('Content-Type', upstream.headers.get('content-type') || contentType);
    if (request.method === 'HEAD' || !upstream.body) {
      response.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body), response, {
      signal: upstreamContext.signal
    });
  } catch (error) {
    if (isUpstreamAbort(error, upstreamContext.signal)) {
      handleUpstreamAbort(request, response, 'Worldwide map asset');
      return;
    }
    throw error;
  } finally {
    upstreamContext.cleanup();
  }
}

async function serveWorldManifest(request, response) {
  const upstreamContext = createUpstreamContext(request, response);
  try {
    const upstream = await fetch(releaseAssetUrl(worldManifestAsset), {
      headers: {
        'User-Agent': 'Occu-Med-Map/world-manifest-proxy',
        Accept: 'application/json'
      },
      redirect: 'follow',
      signal: upstreamContext.signal
    });
    if (!upstream.ok) {
      send(
        response,
        upstream.status === 404 ? 404 : 502,
        upstream.status === 404 ? 'Worldwide map manifest not built yet' : 'Worldwide map manifest upstream failed',
        'text/plain; charset=utf-8',
        'no-store',
        request.method
      );
      return;
    }
    const manifest = (await upstream.text())
      .replaceAll('__OCCUMED_PUBLIC_ORIGIN__', requestOrigin(request));
    send(
      response,
      200,
      manifest,
      contentTypes['.json'],
      'public, max-age=300, must-revalidate',
      request.method
    );
  } catch (error) {
    if (isUpstreamAbort(error, upstreamContext.signal)) {
      handleUpstreamAbort(request, response, 'Worldwide map manifest');
      return;
    }
    throw error;
  } finally {
    upstreamContext.cleanup();
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

function pipeFile(response, absolute, options = {}) {
  const stream = createReadStream(absolute, options);
  stream.on('error', (error) => response.destroy(error));
  stream.pipe(response);
}

async function servePmtiles(request, response, absolute, stat) {
  const cacheControl = 'public, max-age=3600, must-revalidate';
  const rangeHeader = request.headers.range;

  if (!rangeHeader) {
    response.writeHead(200, {
      ...corsHeaders,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      'CDN-Cache-Control': cacheControl,
      'Surrogate-Control': cacheControl,
      'Content-Length': stat.size,
      'Content-Type': contentTypes['.pmtiles']
    });
    if (request.method === 'HEAD') response.end();
    else pipeFile(response, absolute);
    return;
  }

  const range = parseByteRange(rangeHeader, stat.size);
  if (!range) {
    response.writeHead(416, {
      ...corsHeaders,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${stat.size}`,
      'Content-Type': 'text/plain; charset=utf-8'
    });
    response.end('Requested range not satisfiable');
    return;
  }

  const length = range.end - range.start + 1;
  response.writeHead(206, {
    ...corsHeaders,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': cacheControl,
    'Surrogate-Control': cacheControl,
    'Content-Length': length,
    'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
    'Content-Type': contentTypes['.pmtiles']
  });

  if (request.method === 'HEAD') response.end();
  else pipeFile(response, absolute, { start: range.start, end: range.end });
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
      ...corsHeaders,
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

  if (url.pathname === '/world-manifest.json') {
    await serveWorldManifest(request, response);
    return;
  }

  const worldAssetMatch = /^\/world-tiles\/(occumed-[a-z0-9-]+\.pmtiles)$/.exec(url.pathname);
  if (worldAssetMatch) {
    await proxyReleaseAsset(
      request,
      response,
      worldAssetMatch[1],
      contentTypes['.pmtiles'],
      'public, max-age=86400, immutable'
    );
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
