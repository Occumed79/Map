#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repository = process.env.OCCUMED_WORLD_RELEASE_REPOSITORY?.trim() || 'Occumed79/Map';
const tag = process.env.OCCUMED_WORLD_RELEASE_TAG?.trim() || 'occumed-world-v1';
const port = Number(process.env.PORT || 4173);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'dist', 'virtual-assets');
const maxAssetBytes = Number(process.env.OCCUMED_NAVIGATION_ASSET_MAX_BYTES || 512 * 1024 * 1024);
const required = process.env.OCCUMED_REQUIRE_LOCAL_NAVIGATION_ASSETS !== 'false';
const defaultNavigationCacheBytesPerProject = 48 * 1024 * 1024;

const assets = [
  {
    name: 'occumed-world-overview.pmtiles',
    explicitUrl: process.env.OCCUMED_WORLD_OVERVIEW_SOURCE_URL?.trim()
  },
  {
    name: 'occumed-world-surface.pmtiles',
    explicitUrl: process.env.OCCUMED_WORLD_SURFACE_SOURCE_URL?.trim()
  }
];

function releaseUrl(name) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

async function validPmtiles(filename) {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size < 127 || stat.size > maxAssetBytes) return false;
    const handle = await fs.open(filename, 'r');
    try {
      const magic = Buffer.alloc(7);
      const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
      return bytesRead === 7 && magic.toString('utf8') === 'PMTiles';
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function downloadAsset(asset) {
  const destination = path.join(assetDir, asset.name);
  if (await validPmtiles(destination)) {
    console.log(`Using localized navigation archive ${asset.name}.`);
    return destination;
  }

  const sourceUrl = asset.explicitUrl || releaseUrl(asset.name);
  const parsed = new URL(sourceUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Navigation archive ${asset.name} must use HTTP or HTTPS.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Download timed out for ${asset.name}.`)), 180_000);
  const temporary = `${destination}.${process.pid}.tmp`;

  try {
    const response = await fetch(parsed, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Occu-Med-Map/local-navigation-assets' }
    });
    if (!response.ok || !response.body) {
      throw new Error(`Navigation archive ${asset.name} returned HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxAssetBytes) {
      throw new Error(`Navigation archive ${asset.name} exceeds the ${maxAssetBytes}-byte limit.`);
    }

    await fs.mkdir(assetDir, { recursive: true });
    await fs.rm(temporary, { force: true });
    await pipeline(
      Readable.fromWeb(response.body),
      await fs.open(temporary, 'w').then((handle) => handle.createWriteStream())
    );

    if (!(await validPmtiles(temporary))) {
      throw new Error(`Downloaded navigation archive ${asset.name} failed PMTiles validation.`);
    }
    await fs.rename(temporary, destination);
    console.log(`Localized ${asset.name} from release storage.`);
    return destination;
  } finally {
    clearTimeout(timeout);
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

let localized = [];
try {
  localized = await Promise.all(assets.map(downloadAsset));
} catch (error) {
  console.error(`Unable to localize navigation archives: ${error.message}`);
  if (required) process.exit(1);
}

const env = { ...process.env };
env.OCCUMED_NAV_CACHE_MAX_BYTES_PER_SHARD ||= String(defaultNavigationCacheBytesPerProject);
if (localized.length === assets.length) {
  const localOrigin = `http://127.0.0.1:${port}/virtual-assets`;
  env.OCCUMED_WORLD_OVERVIEW_URL = `${localOrigin}/${assets[0].name}`;
  env.OCCUMED_WORLD_SURFACE_URL = `${localOrigin}/${assets[1].name}`;
}

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env,
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
