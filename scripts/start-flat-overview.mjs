#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';

const repository = process.env.OCCUMED_WORLD_RELEASE_REPOSITORY?.trim() || 'Occumed79/Map';
const tag = process.env.OCCUMED_WORLD_RELEASE_TAG?.trim() || 'occumed-world-v1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(root, 'dist', 'virtual-assets');
const sourceAssetName = 'occumed-world-surface.pmtiles';
// server-flat.mjs keeps the stable localized filename and tile endpoint.
const destinationAssetName = 'occumed-world-overview.pmtiles';
const destination = path.join(assetDir, destinationAssetName);
const explicitUrl = process.env.OCCUMED_WORLD_SURFACE_SOURCE_URL?.trim();
const maxAssetBytes = Number(process.env.OCCUMED_FLAT_ASSET_MAX_BYTES || 768 * 1024 * 1024);
const requiredLayers = new Set(['land', 'landcover', 'depth']);

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
    const buffer = Buffer.allocUnsafe(Number(length));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Number(offset));
    if (bytesRead !== buffer.length) throw new Error('PMTiles short read during physical-layer validation.');
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
  }

  async close() {
    const handle = await this.handlePromise;
    await handle.close();
  }
}

function releaseUrl() {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(sourceAssetName)}`;
}

async function validArchive(filename) {
  let source;
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size < 127 || stat.size > maxAssetBytes) return false;
    const handle = await fs.open(filename, 'r');
    try {
      const magic = Buffer.alloc(7);
      const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
      if (bytesRead !== 7 || magic.toString('utf8') !== 'PMTiles') return false;
    } finally {
      await handle.close();
    }

    source = new LocalPmtilesSource(filename);
    const archive = new PMTiles(source);
    const [header, metadata] = await Promise.all([archive.getHeader(), archive.getMetadata()]);
    if (Number(header.minZoom) !== 0 || Number(header.maxZoom) < 5) return false;
    const layerIds = new Set((metadata?.vector_layers || []).map((layer) => layer?.id).filter(Boolean));
    return [...requiredLayers].every((layer) => layerIds.has(layer));
  } catch {
    return false;
  } finally {
    await source?.close().catch(() => {});
  }
}

async function localizeArchive() {
  if (await validArchive(destination)) {
    console.log(`Using localized authoritative physical archive ${destinationAssetName}.`);
    return;
  }

  const sourceUrl = explicitUrl || releaseUrl();
  const parsed = new URL(sourceUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Flat physical-surface source must use HTTP or HTTPS.');
  }

  await fs.mkdir(assetDir, { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.rm(temporary, { force: true });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Download timed out for ${sourceAssetName}.`)),
    10 * 60_000
  );
  timeout.unref?.();

  try {
    const response = await fetch(parsed, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Occu-Med-Map/flat-authoritative-surface-localizer' }
    });
    if (!response.ok || !response.body) {
      throw new Error(`Authoritative world-surface archive returned HTTP ${response.status}.`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxAssetBytes) {
      throw new Error(`Authoritative world-surface archive exceeds ${maxAssetBytes} bytes.`);
    }

    await pipeline(
      Readable.fromWeb(response.body),
      await fs.open(temporary, 'w').then((handle) => handle.createWriteStream())
    );

    if (!(await validArchive(temporary))) {
      throw new Error('Downloaded archive is missing required land, landcover, or depth layers.');
    }

    await fs.rename(temporary, destination);
    console.log(`Localized ${sourceAssetName} as the stable flat-map archive ${destinationAssetName}.`);
  } finally {
    clearTimeout(timeout);
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

try {
  await localizeArchive();
} catch (error) {
  console.error(`Unable to prepare authoritative flat-map surface: ${error.message}`);
  process.exit(1);
}

const child = spawn(process.execPath, ['server-flat.mjs'], {
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
