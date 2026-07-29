import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const publicRoot = path.join(root, 'dist');
const archivePath = path.resolve(process.env.OCCUMED_CANDIDATE_ARCHIVE || '');
const family = process.env.OCCUMED_CANDIDATE_FAMILY?.trim() || 'unknown';
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST?.trim() || '0.0.0.0';

if (!process.env.OCCUMED_CANDIDATE_ARCHIVE) {
  throw new Error('OCCUMED_CANDIDATE_ARCHIVE is required.');
}
if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(family)) {
  throw new Error('OCCUMED_CANDIDATE_FAMILY contains unsupported characters.');
}

const types = {
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

class LocalSource {
  constructor(filename) {
    this.filename = filename;
    this.handle = fs.open(filename, 'r');
  }
  getKey() {
    return this.filename;
  }
  async getBytes(offset, length) {
    const handle = await this.handle;
    const buffer = Buffer.allocUnsafe(Number(length));
    const result = await handle.read(buffer, 0, Number(length), Number(offset));
    if (result.bytesRead !== Number(length)) throw new Error('Short PMTiles read.');
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  }
  async close() {
    await (await this.handle).close();
  }
}

function write(response, status, body, contentType, method = 'GET', extra = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Occumed-Candidate': family,
    ...extra
  });
  if (method === 'HEAD') response.end();
  else response.end(payload);
}

function originFor(request) {
  const hostHeader = String(request.headers.host || `127.0.0.1:${port}`);
  return `http://${hostHeader}`;
}

function validTile(z, x, y, maxZoom) {
  if (![z, x, y].every(Number.isSafeInteger)) return false;
  if (z < 0 || z > maxZoom) return false;
  const width = 2 ** z;
  return x >= 0 && x < width && y >= 0 && y < width;
}

async function staticFile(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requested);
  if (decoded.includes('\0')) return write(response, 400, 'Invalid path', 'text/plain', request.method);
  const absolute = path.resolve(publicRoot, `.${decoded}`);
  if (!absolute.startsWith(`${publicRoot}${path.sep}`) && absolute !== path.join(publicRoot, 'index.html')) {
    return write(response, 403, 'Forbidden', 'text/plain', request.method);
  }
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Not a file');
    const body = await fs.readFile(absolute);
    return write(response, 200, body, types[path.extname(absolute).toLowerCase()] || 'application/octet-stream', request.method);
  } catch {
    if (path.extname(decoded)) return write(response, 404, 'Not found', 'text/plain', request.method);
    const body = await fs.readFile(path.join(publicRoot, 'index.html'));
    return write(response, 200, body, types['.html'], request.method);
  }
}

const source = new LocalSource(archivePath);
const archive = new PMTiles(source);
const header = await archive.getHeader();
const maxZoom = Number(header.maxZoom);
if (!Number.isSafeInteger(maxZoom) || maxZoom < 0) throw new Error('Candidate has invalid maxZoom.');

const server = http.createServer((request, response) => {
  void (async () => {
    const method = request.method || 'GET';
    if (!['GET', 'HEAD'].includes(method)) return write(response, 405, 'Method not allowed', 'text/plain', method);
    const url = new URL(request.url || '/', originFor(request));

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return write(response, 200, 'ok', 'text/plain', method);
    }
    if (url.pathname === '/readyz') {
      return write(response, 200, `${JSON.stringify({ ready: true, family, archivePath, minZoom: Number(header.minZoom), maxZoom })}\n`, types['.json'], method);
    }
    if (url.pathname === '/style/occumed-open.json') {
      const style = await fs.readFile(path.join(publicRoot, 'style', 'occumed-open.json'), 'utf8');
      return write(response, 200, style.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', originFor(request)), types['.json'], method);
    }

    const match = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(url.pathname);
    if (match) {
      const z = Number(match[1]);
      const x = Number(match[2]);
      const y = Number(match[3]);
      if (!validTile(z, x, y, maxZoom)) return write(response, 404, 'Tile not found', 'text/plain', method);
      const tile = await archive.getZxy(z, x, y);
      if (!tile?.data) return write(response, 204, Buffer.alloc(0), types['.pbf'], method);
      return write(response, 200, Buffer.from(tile.data), types['.pbf'], method, {
        'Content-Encoding': 'gzip'
      });
    }

    return staticFile(request, response, url.pathname);
  })().catch((error) => {
    console.error(error);
    if (!response.headersSent) write(response, 500, 'Internal server error', 'text/plain', request.method);
    else response.destroy();
  });
});

server.requestTimeout = 45_000;
server.headersTimeout = 20_000;
server.listen(port, host, () => {
  console.log(`Candidate ${family} listening on ${host}:${port} from ${archivePath}, z${header.minZoom}-${header.maxZoom}.`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => server.close(() => void source.close()));
}
