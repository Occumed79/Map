import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';

const port = 43173;
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

async function request(method) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health?render-probe=1',
        method,
        timeout: 3000,
        headers: { Host: `map-yxjb.onrender.com:${port}` }
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method} /health timed out`)));
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

  const get = await request('GET');
  if (get.status !== 200 || get.body !== 'ok') {
    throw new Error(`GET /health returned ${get.status} with body ${JSON.stringify(get.body)}`);
  }

  const head = await request('HEAD');
  if (head.status !== 200 || head.body !== '') {
    throw new Error(`HEAD /health returned ${head.status} with body ${JSON.stringify(head.body)}`);
  }

  console.log('Server health check passed for GET and HEAD with a Render-style Host header.');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) {
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
}
