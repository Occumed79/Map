import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Compression,
  FetchSource,
  findTile,
  PMTiles,
  SharedPromiseCache,
  zxyToTileId
} from 'pmtiles';

const DEFAULT_MANIFEST = 'dist/immutable-world/manifest.json';
const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_OWNER_COUNT = 16_384;

class LocalArchiveSource {
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
    if (this.closed) throw new Error(`Immutable PMTiles source is closed: ${this.filename}`);
    const start = Number(offset);
    const requested = Number(length);
    const [handle, fileSize] = await Promise.all([this.handlePromise, this.sizePromise]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requested) ||
      start < 0 ||
      requested <= 0 ||
      start >= fileSize
    ) {
      throw new RangeError(`Invalid immutable PMTiles range ${offset}+${length}.`);
    }
    const size = Math.min(requested, fileSize - start);
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    if (bytesRead !== size) {
      throw new Error(
        `Short immutable PMTiles read from ${this.filename}: expected ${size}, received ${bytesRead}.`
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

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function normalizeCoordinate(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function normalizeTile(zValue, xValue, yValue, maxZoom) {
  const z = normalizeCoordinate(zValue, 'Tile z');
  const x = normalizeCoordinate(xValue, 'Tile x');
  const y = normalizeCoordinate(yValue, 'Tile y');
  if (z > maxZoom) return null;
  const width = 2 ** z;
  if (x >= width || y >= width) return null;
  return { z, x, y };
}

function canonicalDocument(value) {
  if (Array.isArray(value)) return value.map(canonicalDocument);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => !['artifactVersion', 'generatedAt'].includes(key))
      .map((key) => [key, canonicalDocument(value[key])])
  );
}

export function computeImmutableArtifactVersion(manifest) {
  return createHash('sha256')
    .update(`${JSON.stringify(canonicalDocument(manifest))}\n`)
    .digest('hex');
}

function validateSha(value, label) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function validateAsset(asset, label) {
  if (!asset || typeof asset !== 'object') throw new TypeError(`${label} is missing.`);
  if (!/^[a-z0-9][a-z0-9._/-]*\.pmtiles$/.test(String(asset.file || ''))) {
    throw new TypeError(`${label}.file is not a safe PMTiles path.`);
  }
  if (String(asset.file).includes('..') || path.isAbsolute(String(asset.file))) {
    throw new TypeError(`${label}.file must stay beneath the immutable asset root.`);
  }
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 127) {
    throw new TypeError(`${label}.bytes is invalid.`);
  }
  validateSha(asset.sha256, `${label}.sha256`);
}

function prefixContains(ancestor, candidate) {
  if (ancestor.z > candidate.z) return false;
  const divisor = 2 ** (candidate.z - ancestor.z);
  return (
    Math.floor(candidate.x / divisor) === ancestor.x &&
    Math.floor(candidate.y / divisor) === ancestor.y
  );
}

function normalizePrefix(prefix, label) {
  const z = normalizeCoordinate(prefix?.z, `${label}.z`);
  const x = normalizeCoordinate(prefix?.x, `${label}.x`);
  const y = normalizeCoordinate(prefix?.y, `${label}.y`);
  const width = 2 ** z;
  if (z > 16 || x >= width || y >= width) {
    throw new TypeError(`${label} is outside the z0-z16 tile pyramid.`);
  }
  return { z, x, y };
}

export function validateImmutableManifest(document, {
  allowPartial = false
} = {}) {
  if (!document || typeof document !== 'object') throw new TypeError('Immutable tileset manifest is missing.');
  if (document.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported immutable manifest schema: ${document.schemaVersion}`);
  }
  if (document.browserSourceId !== 'occumed-open') {
    throw new TypeError('Immutable manifest browser source must remain occumed-open.');
  }
  if (document.maxZoom !== 16 || document.minZoom !== 0) {
    throw new TypeError('Immutable manifest must cover the z0-z16 pyramid.');
  }
  if (
    document.authorities?.land !== 'world-surface' ||
    document.authorities?.depth !== 'world-surface' ||
    document.authorities?.landcover !== 'world-overview' ||
    document.authorities?.cartography !== 'regional-owner'
  ) {
    throw new TypeError('Immutable manifest has an invalid source authority matrix.');
  }
  for (const forbidden of [
    'neonTileCache',
    'runtimeShardMerge',
    'runtimeLandcoverSynthesis',
    'runtimeGeometry',
    'parentChildStretching'
  ]) {
    if (document.runtimePolicy?.[forbidden] !== false) {
      throw new TypeError(`Immutable manifest does not disable ${forbidden}.`);
    }
  }

  validateAsset(document.foundation, 'foundation');
  if (!Number.isSafeInteger(document.foundation.maxZoom) ||
      document.foundation.maxZoom < 0 ||
      document.foundation.maxZoom > 16) {
    throw new TypeError('foundation.maxZoom is invalid.');
  }
  const owners = Array.isArray(document.owners) ? document.owners : [];
  if (owners.length > MAX_OWNER_COUNT) throw new TypeError('Immutable owner count is unsafe.');
  if (!Number.isSafeInteger(document.plannedOwnerCount) || document.plannedOwnerCount < 0) {
    throw new TypeError('plannedOwnerCount is invalid.');
  }
  if (!Number.isSafeInteger(document.builtOwnerCount) ||
      document.builtOwnerCount !== owners.length) {
    throw new TypeError('builtOwnerCount does not match the owner inventory.');
  }
  if (!document.complete && !allowPartial) {
    throw new Error(
      `Immutable tileset is incomplete: ${owners.length} of ${document.plannedOwnerCount} owners.`
    );
  }
  if (document.complete && owners.length !== document.plannedOwnerCount) {
    throw new Error('A complete immutable tileset must include every planned owner.');
  }
  if (document.defaultOwner !== document.foundation.id) {
    throw new TypeError('The worldwide default owner must be the prebuilt foundation.');
  }

  const ids = new Set([document.foundation.id]);
  const files = new Set([document.foundation.file]);
  const prefixes = [];
  const exactTileOwners = new Map();
  const normalizedOwners = owners.map((owner, index) => {
    validateAsset(owner, `owners[${index}]`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(owner.id || ''))) {
      throw new TypeError(`owners[${index}].id is invalid.`);
    }
    if (ids.has(owner.id)) throw new TypeError(`Duplicate immutable owner id: ${owner.id}`);
    if (files.has(owner.file)) throw new TypeError(`Duplicate immutable owner file: ${owner.file}`);
    ids.add(owner.id);
    files.add(owner.file);
    const prefix = normalizePrefix(owner.prefix, `owners[${index}].prefix`);
    for (const existing of prefixes) {
      if (prefixContains(existing, prefix) || prefixContains(prefix, existing)) {
        throw new TypeError(
          `Overlapping immutable owner prefixes: ${existing.z}/${existing.x}/${existing.y} and ` +
          `${prefix.z}/${prefix.x}/${prefix.y}.`
        );
      }
    }
    prefixes.push(prefix);
    const exactTiles = (owner.exactTiles || []).map((tile, tileIndex) => {
      const exact = normalizePrefix(tile, `owners[${index}].exactTiles[${tileIndex}]`);
      if (exact.z <= document.foundation.maxZoom) {
        throw new TypeError(
          `Owner exact tile ${exact.z}/${exact.x}/${exact.y} overlaps the foundation.`
        );
      }
      const exactKey = `${exact.z}/${exact.x}/${exact.y}`;
      if (exactTileOwners.has(exactKey)) {
        throw new TypeError(
          `Exact tile ${exactKey} is assigned to both ${exactTileOwners.get(exactKey)} and ${owner.id}.`
        );
      }
      exactTileOwners.set(exactKey, owner.id);
      return exact;
    });
    return { ...owner, prefix, exactTiles };
  });
  for (const [exactKey, exactOwner] of exactTileOwners) {
    const [z, x, y] = exactKey.split('/').map(Number);
    const matchingPrefixes = normalizedOwners.filter((owner) =>
      prefixContains(owner.prefix, { z, x, y })
    );
    if (matchingPrefixes.length) {
      throw new TypeError(
        `Exact tile ${exactKey} for ${exactOwner} overlaps prefix owner ` +
        `${matchingPrefixes[0].id}.`
      );
    }
  }

  const computedVersion = computeImmutableArtifactVersion(document);
  if (document.artifactVersion !== computedVersion) {
    throw new Error(
      `Immutable artifact version mismatch: expected ${computedVersion}, ` +
      `received ${document.artifactVersion}.`
    );
  }
  return {
    ...document,
    owners: normalizedOwners
  };
}

async function readManifest(location) {
  if (isHttpUrl(location)) {
    const response = await fetch(location, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Occu-Med-Map/immutable-tileset' }
    });
    if (!response.ok) throw new Error(`Immutable manifest returned HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_MANIFEST_BYTES) {
      throw new Error('Immutable manifest exceeds the size budget.');
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
      throw new Error('Immutable manifest exceeds the size budget.');
    }
    return JSON.parse(text);
  }

  const stat = await fs.stat(location);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error('Immutable manifest is missing or exceeds the size budget.');
  }
  return JSON.parse(await fs.readFile(location, 'utf8'));
}

function resolveRemoteAsset(baseUrl, file) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new TypeError('Immutable assetBaseUrl must use HTTP or HTTPS.');
  }
  return new URL(file, base.href.endsWith('/') ? base.href : `${base.href}/`).href;
}

function buildOwnerIndex(manifest) {
  const exact = new Map();
  const prefixes = new Map();
  for (const owner of manifest.owners) {
    for (const tile of owner.exactTiles) {
      exact.set(`${tile.z}/${tile.x}/${tile.y}`, owner);
    }
    const zoomOwners = prefixes.get(owner.prefix.z) || new Map();
    zoomOwners.set(`${owner.prefix.x}/${owner.prefix.y}`, owner);
    prefixes.set(owner.prefix.z, zoomOwners);
  }
  return {
    exact,
    prefixes,
    prefixZooms: [...prefixes.keys()].sort((left, right) => right - left)
  };
}

export class ImmutableWorldTileset {
  constructor({
    root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    manifestLocation = process.env.OCCUMED_IMMUTABLE_TILESET_MANIFEST?.trim(),
    allowPartial = process.env.OCCUMED_ALLOW_PARTIAL_TILESET_FIXTURE === 'true',
    maxTileBytes = 32 * 1024 * 1024
  } = {}) {
    this.root = path.resolve(root);
    this.manifestLocation = manifestLocation
      ? (isHttpUrl(manifestLocation) ? manifestLocation : path.resolve(manifestLocation))
      : path.join(this.root, DEFAULT_MANIFEST);
    this.allowPartial = allowPartial;
    this.maxTileBytes = maxTileBytes;
    this.manifestPromise = null;
    this.ownerIndex = null;
    this.archives = new Map();
    this.closed = false;
  }

  async loadManifest() {
    if (this.closed) throw new Error('Immutable tileset is closed.');
    if (!this.manifestPromise) {
      this.manifestPromise = readManifest(this.manifestLocation)
        .then((document) => validateImmutableManifest(document, {
          allowPartial: this.allowPartial
        }))
        .then((manifest) => {
          this.ownerIndex = buildOwnerIndex(manifest);
          return manifest;
        })
        .catch((error) => {
          this.manifestPromise = null;
          this.ownerIndex = null;
          throw error;
        });
    }
    return this.manifestPromise;
  }

  assetLocation(manifest, asset) {
    if (manifest.assetBaseUrl) return resolveRemoteAsset(manifest.assetBaseUrl, asset.file);
    if (isHttpUrl(this.manifestLocation)) {
      return new URL(asset.file, this.manifestLocation).href;
    }
    const assetRoot = path.dirname(this.manifestLocation);
    const resolved = path.resolve(assetRoot, asset.file);
    if (!resolved.startsWith(`${assetRoot}${path.sep}`)) {
      throw new Error(`Immutable asset escapes its manifest directory: ${asset.file}`);
    }
    return resolved;
  }

  async openArchive(manifest, asset) {
    const location = this.assetLocation(manifest, asset);
    if (this.archives.has(location)) return this.archives.get(location);
    const source = isHttpUrl(location)
      ? new FetchSource(location)
      : new LocalArchiveSource(location);
    const archive = new PMTiles(source, new SharedPromiseCache(256));
    const opened = Promise.all([
      archive.getHeader(),
      isHttpUrl(location) ? Promise.resolve(null) : fs.stat(location)
    ]).then(([header, stat]) => {
      if (header.specVersion !== 3 || header.tileType !== 1) {
        throw new Error(`Immutable asset is not PMTiles v3 MVT: ${asset.file}`);
      }
      if (stat && stat.size !== asset.bytes) {
        throw new Error(
          `Immutable asset size mismatch for ${asset.file}: expected ${asset.bytes}, received ${stat.size}.`
        );
      }
      return { archive, source, header, asset, location };
    });
    this.archives.set(location, opened);
    return opened;
  }

  selectOwner(manifest, tile) {
    if (tile.z <= manifest.foundation.maxZoom) return manifest.foundation;
    if (!this.ownerIndex) throw new Error('Immutable owner index is not initialized.');
    const exact = this.ownerIndex.exact.get(`${tile.z}/${tile.x}/${tile.y}`);
    if (exact) return exact;
    for (const prefixZoom of this.ownerIndex.prefixZooms) {
      if (prefixZoom > tile.z) continue;
      const divisor = 2 ** (tile.z - prefixZoom);
      const owner = this.ownerIndex.prefixes.get(prefixZoom).get(
        `${Math.floor(tile.x / divisor)}/${Math.floor(tile.y / divisor)}`
      );
      if (owner) return owner;
    }
    return manifest.foundation;
  }

  async resolveTile(zValue, xValue, yValue) {
    const manifest = await this.loadManifest();
    const tile = normalizeTile(zValue, xValue, yValue, manifest.maxZoom);
    if (!tile) throw new RangeError('Invalid immutable tile coordinates.');
    const owner = this.selectOwner(manifest, tile);
    const opened = await this.openArchive(manifest, owner);
    const tileId = zxyToTileId(tile.z, tile.x, tile.y);
    let directoryOffset = opened.header.rootDirectoryOffset;
    let directoryLength = opened.header.rootDirectoryLength;
    let data = null;
    for (let depth = 0; depth <= 3; depth += 1) {
      const directory = await opened.archive.cache.getDirectory(
        opened.source,
        directoryOffset,
        directoryLength,
        opened.header
      );
      const entry = findTile(directory, tileId);
      if (!entry) break;
      if (entry.runLength > 0) {
        const stored = await opened.source.getBytes(
          opened.header.tileDataOffset + entry.offset,
          entry.length
        );
        data = Buffer.from(stored.data);
        break;
      }
      directoryOffset = opened.header.leafDirectoryOffset + entry.offset;
      directoryLength = entry.length;
    }
    if (!data) return { data: null, owner, tile, artifactVersion: manifest.artifactVersion };
    if (data.byteLength > this.maxTileBytes) {
      throw new Error(
        `Immutable tile ${tile.z}/${tile.x}/${tile.y} exceeds the production byte limit.`
      );
    }
    let contentEncoding = null;
    if (opened.header.tileCompression === Compression.Gzip) contentEncoding = 'gzip';
    else if (
      opened.header.tileCompression !== Compression.None &&
      opened.header.tileCompression !== Compression.Unknown
    ) {
      throw new Error(
        `Immutable tile compression is not HTTP-safe: ${opened.header.tileCompression}.`
      );
    }
    return {
      data,
      contentEncoding,
      owner,
      tile,
      artifactVersion: manifest.artifactVersion
    };
  }

  async ready() {
    const manifest = await this.loadManifest();
    const foundation = await this.openArchive(manifest, manifest.foundation);
    return {
      ready: true,
      architecture: 'immutable-prebuilt-pmtiles-v1',
      artifactVersion: manifest.artifactVersion,
      complete: manifest.complete,
      builtOwnerCount: manifest.builtOwnerCount,
      plannedOwnerCount: manifest.plannedOwnerCount,
      foundationTiles: foundation.header.numAddressedTiles,
      sourceCount: 1
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const opened = await Promise.allSettled([...this.archives.values()]);
    await Promise.allSettled(
      opened
        .filter((result) => result.status === 'fulfilled')
        .map(({ value }) => value.source?.close?.())
    );
    this.archives.clear();
  }
}
