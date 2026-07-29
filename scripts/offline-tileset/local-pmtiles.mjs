import fs from 'node:fs/promises';
import path from 'node:path';
import { PMTiles, SharedPromiseCache, tileIdToZxy } from 'pmtiles';

/**
 * Exact-range local source for the PMTiles JavaScript reader.
 *
 * Node Buffers may expose a larger backing ArrayBuffer than the requested
 * range. PMTiles requires the returned ArrayBuffer to contain exactly the
 * requested bytes, so every read is sliced to its own byteOffset/byteLength.
 */
export class LocalPmtilesSource {
  constructor(filename) {
    this.filename = path.resolve(filename);
    this.handlePromise = fs.open(this.filename, 'r');
    this.sizePromise = this.handlePromise.then((handle) => handle.stat()).then((stat) => stat.size);
    this.closed = false;
  }

  getKey() {
    return this.filename;
  }

  async getBytes(offset, length) {
    if (this.closed) throw new Error(`PMTiles source is closed: ${this.filename}`);
    const start = Number(offset);
    const size = Number(length);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(size) ||
      start < 0 ||
      size <= 0
    ) {
      throw new RangeError(`Invalid PMTiles range ${offset}+${length}.`);
    }

    const [handle, fileSize] = await Promise.all([this.handlePromise, this.sizePromise]);
    if (start >= fileSize) {
      throw new RangeError(`PMTiles range starts beyond EOF: ${start} >= ${fileSize}.`);
    }
    const actualSize = Math.min(size, fileSize - start);
    const buffer = Buffer.allocUnsafe(actualSize);
    const { bytesRead } = await handle.read(buffer, 0, actualSize, start);
    if (bytesRead !== actualSize) {
      throw new Error(
        `Short PMTiles read from ${this.filename}: expected ${actualSize}, received ${bytesRead}.`
      );
    }

    return {
      data: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      )
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await (await this.handlePromise).close();
  }
}

export async function openLocalPmtiles(filename, { cacheEntries = 256 } = {}) {
  const source = new LocalPmtilesSource(filename);
  const archive = new PMTiles(source, new SharedPromiseCache(cacheEntries));
  const header = await archive.getHeader();
  return {
    archive,
    header,
    source,
    async close() {
      await source.close();
    }
  };
}

export function tilePayload(result) {
  if (!result?.data) return null;
  return Buffer.from(
    result.data,
    result.data.byteOffset || 0,
    result.data.byteLength
  );
}

/**
 * Visit every addressed z/x/y in a local PMTiles archive without reading tile
 * payloads. Run-length entries are expanded because every exact address must
 * be assigned to one immutable output owner.
 */
export async function visitPmtilesTileAddresses(opened, visit) {
  const { archive, header, source } = opened;
  const visitedDirectories = new Set();
  let addressedTiles = 0;

  async function walk(offset, length, depth) {
    if (depth > 4) throw new Error('PMTiles directory depth exceeds the v3 safety limit.');
    const key = `${offset}:${length}`;
    if (visitedDirectories.has(key)) return;
    visitedDirectories.add(key);
    const entries = await archive.cache.getDirectory(source, offset, length, header);
    for (const entry of entries) {
      if (entry.runLength > 0) {
        for (let delta = 0; delta < entry.runLength; delta += 1) {
          const tileId = entry.tileId + delta;
          const [z, x, y] = tileIdToZxy(tileId);
          await visit({ z, x, y, tileId });
          addressedTiles += 1;
        }
      } else {
        await walk(
          header.leafDirectoryOffset + entry.offset,
          entry.length,
          depth + 1
        );
      }
    }
  }

  await walk(header.rootDirectoryOffset, header.rootDirectoryLength, 0);
  return {
    addressedTiles,
    directoryCount: visitedDirectories.size
  };
}
