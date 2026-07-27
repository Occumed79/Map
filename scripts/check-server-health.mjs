import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const port = 43173;
const testTilesDir = path.resolve('dist/tiles');
const testArchivePath = path.join(testTilesDir, '__range-test.pmtiles');
const testArchive = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');

await fs.mkdir(testTilesDir, { recursive: true });
await fs.writeFile(testArchivePath, testArchive);

const child = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(port), HOST: '0.0.0.0' },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

async function request({ method = 'GET', pathname = '/health?render-probe=1', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        timeout: 3000,
        headers: { Host: `map-yxjb.onrender.com:${port}`, ...headers }
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks),
            headers: response.headers
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${pathname} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

try {
  const deadline = Date.now() + 8000;
  while (!output.includes('Health endpoint ready')) {
    if (child.exitCode !== null) throw new Error(`Server exited early with code ${child.exitCode}.\n${output}`);
    if (Date.now() > deadline) throw new Error(`Server did not become ready.\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const get = await request();
  if (get.status !== 200 || get.body.toString('utf8') !== 'ok') {
    throw new Error(`GET /health returned ${get.status} with body ${JSON.stringify(get.body.toString('utf8'))}`);
  }

  const head = await request({ method: 'HEAD' });
  if (head.status !== 200 || head.body.length !== 0) {
    throw new Error(`HEAD /health returned ${head.status} with ${head.body.length} body bytes`);
  }

  const range = await request({
    pathname: '/tiles/__range-test.pmtiles',
    headers: { Range: 'bytes=5-14' }
  });
  if (range.status !== 206) throw new Error(`PMTiles range request returned ${range.status} instead of 206.`);
  if (range.body.toString('utf8') !== testArchive.subarray(5, 15).toString('utf8')) {
    throw new Error('PMTiles range response returned the wrong bytes.');
  }
  if (range.headers['accept-ranges'] !== 'bytes') throw new Error('PMTiles response is missing Accept-Ranges: bytes.');
  if (range.headers['content-range'] !== `bytes 5-14/${testArchive.length}`) {
    throw new Error(`Unexpected PMTiles Content-Range: ${range.headers['content-range']}`);
  }
  if (range.headers['content-type'] !== 'application/vnd.pmtiles') {
    throw new Error(`Unexpected PMTiles content type: ${range.headers['content-type']}`);
  }

  const invalidRange = await request({
    pathname: '/tiles/__range-test.pmtiles',
    headers: { Range: `bytes=${testArchive.length + 10}-` }
  });
  if (invalidRange.status !== 416) {
    throw new Error(`Invalid PMTiles range returned ${invalidRange.status} instead of 416.`);
  }

  console.log('Server checks passed: Render health GET/HEAD and PMTiles HTTP byte ranges.');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) {
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
  await fs.rm(testArchivePath, { force: true });
}
