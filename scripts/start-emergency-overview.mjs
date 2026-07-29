#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repository = process.env.OCCUMED_WORLD_RELEASE_REPOSITORY?.trim() || 'Occumed79/Map';
const tag = process.env.OCCUMED_WORLD_RELEASE_TAG?.trim() || 'occumed-world-v1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'dist', 'virtual-assets');
const assetName = 'occumed-world-overview.pmtiles';
const destination = path.join(assetDir, assetName);
const explicitUrl = process.env.OCCUMED_WORLD_OVERVIEW_SOURCE_URL?.trim();
const maxAssetBytes = Number(process.env.OCCUMED_EMERGENCY_ASSET_MAX_BYTES || 512 * 1024 * 1024);

function releaseUrl() {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

async function validArchive(filename) {
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

async function localizeArchive() {
  if (await validArchive(destination)) {
    console.log(`Using localized immutable archive ${assetName}.`);
    return;
  }

  const sourceUrl = explicitUrl || releaseUrl();
  const parsed = new URL(sourceUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Emergency overview source must use HTTP or HTTPS.');
  }

  await fs.mkdir(assetDir, { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.rm(temporary, { force: true });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Download timed out for ${assetName}.`)),
    10 * 60_000
  );
  timeout.unref?.();

  try {
    const response = await fetch(parsed, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Occu-Med-Map/emergency-overview-localizer' }
    });
    if (!response.ok || !response.body) {
      throw new Error(`Emergency overview archive returned HTTP ${response.status}.`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxAssetBytes) {
      throw new Error(`Emergency overview archive exceeds ${maxAssetBytes} bytes.`);
    }

    await pipeline(
      Readable.fromWeb(response.body),
      await fs.open(temporary, 'w').then((handle) => handle.createWriteStream())
    );

    if (!(await validArchive(temporary))) {
      throw new Error('Downloaded emergency overview archive failed PMTiles validation.');
    }

    await fs.rename(temporary, destination);
    console.log(`Localized immutable overview archive ${assetName}.`);
  } finally {
    clearTimeout(timeout);
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

try {
  await localizeArchive();
} catch (error) {
  console.error(`Unable to prepare emergency overview archive: ${error.message}`);
  process.exit(1);
}

const child = spawn(process.execPath, ['server-emergency.mjs'], {
  cwd: root,
  env: { ...process.env },
  stdio: 'inherit'
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
