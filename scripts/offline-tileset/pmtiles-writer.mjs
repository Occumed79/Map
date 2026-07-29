import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import { PMTiles, zxyToTileId } from 'pmtiles';
import { LocalPmtilesSource, tilePayload } from './local-pmtiles.mjs';

const HEADER_BYTES = 127;
const ROOT_DIRECTORY_BUDGET = 16_384 - HEADER_BYTES;
const GZIP = 2;
const MVT = 1;

function putUint64(view, offset, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Unsafe PMTiles uint64 value: ${value}`);
  }
  view.setBigUint64(offset, BigInt(value), true);
}

function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Unsafe PMTiles varint value: ${value}`);
  }
  const bytes = [];
  let remaining = BigInt(value);
  while (remaining >= 0x80n) {
    bytes.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Buffer.from(bytes);
}

function serializeEntries(entries) {
  const chunks = [encodeVarint(entries.length)];
  let previousId = 0;
  for (const entry of entries) {
    chunks.push(encodeVarint(entry.tileId - previousId));
    previousId = entry.tileId;
  }
  for (const entry of entries) chunks.push(encodeVarint(entry.runLength));
  for (const entry of entries) chunks.push(encodeVarint(entry.length));
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const contiguous =
      index > 0 &&
      entry.offset === entries[index - 1].offset + entries[index - 1].length;
    chunks.push(encodeVarint(contiguous ? 0 : entry.offset + 1));
  }
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function buildRootAndLeaves(entries) {
  if (entries.length < 16_384) {
    const root = serializeEntries(entries);
    if (root.byteLength <= ROOT_DIRECTORY_BUDGET) {
      return { root, leaves: Buffer.alloc(0), leafCount: 0 };
    }
  }

  let leafSize = Math.max(4_096, Math.ceil(entries.length / 3_500));
  while (true) {
    const rootEntries = [];
    const leafChunks = [];
    let leafOffset = 0;
    for (let index = 0; index < entries.length; index += leafSize) {
      const leaf = serializeEntries(entries.slice(index, index + leafSize));
      rootEntries.push({
        tileId: entries[index].tileId,
        offset: leafOffset,
        length: leaf.byteLength,
        runLength: 0
      });
      leafChunks.push(leaf);
      leafOffset += leaf.byteLength;
    }
    const root = serializeEntries(rootEntries);
    if (root.byteLength <= ROOT_DIRECTORY_BUDGET) {
      return {
        root,
        leaves: Buffer.concat(leafChunks),
        leafCount: leafChunks.length
      };
    }
    leafSize = Math.ceil(leafSize * 1.2);
  }
}

function clampE7(value, minimum, maximum) {
  return Math.round(Math.min(maximum, Math.max(minimum, value)) * 10_000_000);
}

function serializeHeader(header) {
  const buffer = Buffer.alloc(HEADER_BYTES);
  buffer.write('PMTiles', 0, 7, 'utf8');
  buffer[7] = 3;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  putUint64(view, 8, header.rootOffset);
  putUint64(view, 16, header.rootLength);
  putUint64(view, 24, header.metadataOffset);
  putUint64(view, 32, header.metadataLength);
  putUint64(view, 40, header.leafOffset);
  putUint64(view, 48, header.leafLength);
  putUint64(view, 56, header.tileDataOffset);
  putUint64(view, 64, header.tileDataLength);
  putUint64(view, 72, header.addressedTiles);
  putUint64(view, 80, header.tileEntries);
  putUint64(view, 88, header.tileContents);
  buffer[96] = 1;
  buffer[97] = GZIP;
  buffer[98] = GZIP;
  buffer[99] = MVT;
  buffer[100] = header.minZoom;
  buffer[101] = header.maxZoom;
  view.setInt32(102, clampE7(header.bounds[0], -180, 180), true);
  view.setInt32(106, clampE7(header.bounds[1], -85.0511288, 85.0511288), true);
  view.setInt32(110, clampE7(header.bounds[2], -180, 180), true);
  view.setInt32(114, clampE7(header.bounds[3], -85.0511288, 85.0511288), true);
  buffer[118] = header.center[2];
  view.setInt32(119, clampE7(header.center[0], -180, 180), true);
  view.setInt32(123, clampE7(header.center[1], -85.0511288, 85.0511288), true);
  return buffer;
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(filename), hash);
  return hash.digest('hex');
}

async function syncFile(filename) {
  const handle = await fsp.open(filename, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function verifyPmtiles(filename, expected = {}) {
  const stat = await fsp.stat(filename);
  if (!stat.isFile() || stat.size < HEADER_BYTES) {
    throw new Error(`Invalid PMTiles output: ${filename}`);
  }
  const source = new LocalPmtilesSource(filename);
  try {
    const archive = new PMTiles(source);
    const header = await archive.getHeader();
    if (header.specVersion !== 3 || header.tileType !== MVT) {
      throw new Error(`Unexpected PMTiles header for ${filename}.`);
    }
    if (expected.addressedTiles !== undefined &&
        header.numAddressedTiles !== expected.addressedTiles) {
      throw new Error(
        `PMTiles addressed-tile mismatch: expected ${expected.addressedTiles}, ` +
        `received ${header.numAddressedTiles}.`
      );
    }
    for (const tile of expected.sampleTiles || []) {
      const payload = tilePayload(await archive.getZxy(tile.z, tile.x, tile.y));
      if (!payload?.byteLength) {
        throw new Error(`PMTiles verification sample is missing ${tile.z}/${tile.x}/${tile.y}.`);
      }
    }
    return {
      bytes: stat.size,
      sha256: await sha256File(filename),
      header
    };
  } finally {
    await source.close();
  }
}

/**
 * Deterministic PMTiles v3 writer for prebuilt MVT tiles.
 *
 * Tiles must be added in increasing Hilbert tile-id order. Payloads are
 * compressed and content-deduplicated before the final directory is emitted.
 */
export class DeterministicPmtilesWriter {
  constructor({
    output,
    workDirectory,
    metadata = {},
    bounds = [-180, -85.0511288, 180, 85.0511288]
  }) {
    this.output = path.resolve(output);
    this.workDirectory = path.resolve(workDirectory);
    this.metadata = metadata;
    this.bounds = bounds;
    this.entries = [];
    this.content = new Map();
    this.dataBytes = 0;
    this.addressedTiles = 0;
    this.previousTileId = -1;
    this.minZoom = 30;
    this.maxZoom = 0;
    this.coordinates = [];
    this.dataPath = path.join(
      this.workDirectory,
      `tile-data-${process.pid}-${Date.now()}.bin`
    );
    this.dataHandlePromise = null;
  }

  async initialize() {
    await fsp.mkdir(this.workDirectory, { recursive: true });
    await fsp.mkdir(path.dirname(this.output), { recursive: true });
    this.dataHandlePromise = fsp.open(this.dataPath, 'wx');
    return this;
  }

  async addTile({ z, x, y, data }) {
    if (!this.dataHandlePromise) throw new Error('PMTiles writer is not initialized.');
    const tileId = zxyToTileId(z, x, y);
    if (tileId <= this.previousTileId) {
      throw new Error(`PMTiles tiles are not strictly ordered at ${z}/${x}/${y}.`);
    }
    this.previousTileId = tileId;
    this.minZoom = Math.min(this.minZoom, z);
    this.maxZoom = Math.max(this.maxZoom, z);
    this.coordinates.push({ z, x, y });

    const raw = Buffer.from(data);
    if (!raw.byteLength) throw new Error(`Cannot add an empty tile payload at ${z}/${x}/${y}.`);
    const contentKey = createHash('sha256').update(raw).digest('hex');
    let stored = this.content.get(contentKey);
    if (!stored) {
      const compressed =
        raw[0] === 0x1f && raw[1] === 0x8b
          ? raw
          : gzipSync(raw, { level: 9 });
      const handle = await this.dataHandlePromise;
      await handle.write(compressed, 0, compressed.byteLength, this.dataBytes);
      stored = { offset: this.dataBytes, length: compressed.byteLength };
      this.content.set(contentKey, stored);
      this.dataBytes += compressed.byteLength;
    }

    const previous = this.entries.at(-1);
    if (
      previous &&
      tileId === previous.tileId + previous.runLength &&
      previous.offset === stored.offset &&
      previous.runLength < 0xffff_ffff
    ) {
      previous.runLength += 1;
    } else {
      this.entries.push({
        tileId,
        offset: stored.offset,
        length: stored.length,
        runLength: 1
      });
    }
    this.addressedTiles += 1;
  }

  async finalize() {
    if (!this.entries.length) throw new Error('Cannot finalize an empty PMTiles archive.');
    const dataHandle = await this.dataHandlePromise;
    await dataHandle.sync();
    await dataHandle.close();
    this.dataHandlePromise = null;

    const { root, leaves, leafCount } = buildRootAndLeaves(this.entries);
    const metadata = gzipSync(
      Buffer.from(`${JSON.stringify(this.metadata)}\n`),
      { level: 9 }
    );
    const rootOffset = HEADER_BYTES;
    const metadataOffset = rootOffset + root.byteLength;
    const leafOffset = metadataOffset + metadata.byteLength;
    const tileDataOffset = leafOffset + leaves.byteLength;
    const center = [
      (this.bounds[0] + this.bounds[2]) / 2,
      (this.bounds[1] + this.bounds[3]) / 2,
      this.minZoom
    ];
    const header = serializeHeader({
      rootOffset,
      rootLength: root.byteLength,
      metadataOffset,
      metadataLength: metadata.byteLength,
      leafOffset,
      leafLength: leaves.byteLength,
      tileDataOffset,
      tileDataLength: this.dataBytes,
      addressedTiles: this.addressedTiles,
      tileEntries: this.entries.length,
      tileContents: this.content.size,
      minZoom: this.minZoom,
      maxZoom: this.maxZoom,
      bounds: this.bounds,
      center
    });

    const unique = `${process.pid}-${Date.now()}`;
    const staged = path.join(this.workDirectory, `archive-${unique}.staged.pmtiles`);
    const pending = `${this.output}.pending-${unique}`;
    const stagedHandle = await fsp.open(staged, 'wx');
    try {
      await stagedHandle.write(header);
      await stagedHandle.write(root);
      await stagedHandle.write(metadata);
      await stagedHandle.write(leaves);
      let position = tileDataOffset;
      for await (const chunk of fs.createReadStream(this.dataPath)) {
        await stagedHandle.write(chunk, 0, chunk.byteLength, position);
        position += chunk.byteLength;
      }
      if (position !== tileDataOffset + this.dataBytes) {
        throw new Error('PMTiles tile-data copy ended at an unexpected offset.');
      }
      await stagedHandle.sync();
    } finally {
      await stagedHandle.close().catch(() => {});
    }

    const samples = [
      this.coordinates[0],
      this.coordinates[Math.floor(this.coordinates.length / 2)],
      this.coordinates.at(-1)
    ];
    const stagedVerification = await verifyPmtiles(staged, {
      addressedTiles: this.addressedTiles,
      sampleTiles: samples
    });
    await fsp.copyFile(staged, pending, fs.constants.COPYFILE_EXCL);
    await syncFile(pending);
    const pendingVerification = await verifyPmtiles(pending, {
      addressedTiles: this.addressedTiles,
      sampleTiles: samples
    });
    if (
      stagedVerification.bytes !== pendingVerification.bytes ||
      stagedVerification.sha256 !== pendingVerification.sha256
    ) {
      throw new Error('PMTiles staged and pending files are not byte-identical.');
    }

    await fsp.rename(pending, this.output);
    await syncFile(this.output);
    const finalVerification = await verifyPmtiles(this.output, {
      addressedTiles: this.addressedTiles,
      sampleTiles: samples
    });
    if (finalVerification.sha256 !== stagedVerification.sha256) {
      throw new Error('PMTiles output changed during atomic promotion.');
    }

    await Promise.allSettled([
      fsp.unlink(staged),
      fsp.unlink(this.dataPath)
    ]);
    return {
      ...finalVerification,
      addressedTiles: this.addressedTiles,
      tileEntries: this.entries.length,
      tileContents: this.content.size,
      leafCount,
      minZoom: this.minZoom,
      maxZoom: this.maxZoom
    };
  }

  async abort() {
    if (this.dataHandlePromise) {
      const handle = await this.dataHandlePromise.catch(() => null);
      await handle?.close().catch(() => {});
      this.dataHandlePromise = null;
    }
    await fsp.unlink(this.dataPath).catch(() => {});
  }
}
