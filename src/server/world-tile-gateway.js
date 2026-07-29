import { createHash } from 'node:crypto';
import { PMTiles, SharedPromiseCache } from 'pmtiles';
import {
  copyVectorLayer,
  EMPTY_MVT,
  mergeVectorTiles,
  overscaleVectorLayer
} from './mvt.js';
import { RetryingFetchSource } from './pmtiles-source.js';
import {
  normalizeTileCoordinates,
  WorldTileRoutingIndex
} from './world-tile-routing.js';

const DEFAULT_OVERVIEW_ASSET = 'occumed-world-overview.pmtiles';
const DEFAULT_SURFACE_ASSET = 'occumed-world-surface.pmtiles';
const DEFAULT_OVERVIEW_MAX_ZOOM = 5;
const DEFAULT_SURFACE_MAX_ZOOM = 10;
const DEFAULT_ROUTING_ZOOM = 6;
const DEFAULT_MAX_ZOOM = 16;
const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_CACHE_STALE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CACHE_ENTRIES = 8_192;
const DEFAULT_MANIFEST_TIMEOUT_MS = 10_000;
const DEFAULT_MANIFEST_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MANIFEST_STALE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_REGIONS = 2_000;
const DEFAULT_MAX_TILE_FANOUT = 64;
const DEFAULT_MAX_INFLIGHT_TILES = 128;
const DEFAULT_MAX_ARCHIVE_READS = 32;
const DEFAULT_MAX_ARCHIVE_QUEUE = 256;
const DEFAULT_MAX_UPSTREAM_TILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RESOLVED_TILE_BYTES = 24 * 1024 * 1024;
const CONTINUOUS_SURFACE_LAYERS = Object.freeze(['land', 'landcover', 'depth']);
const LANDCOVER_FALLBACK_PROPERTIES = Object.freeze({ class: 'grass' });

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function validateHttpUrl(value, label) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError(`${label} must use HTTP or HTTPS.`);
  }
  return url.href;
}

export class GatewayOverloadedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayOverloadedError';
    this.code = 'OCCUMED_GATEWAY_OVERLOADED';
    this.statusCode = 503;
  }
}

class AsyncLimiter {
  constructor(limit, maxQueue) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }

  async run(task) {
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueue) {
        throw new GatewayOverloadedError('The PMTiles archive-read queue is full.');
      }
      await new Promise((resolve) => this.queue.push(resolve));
    }

    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }

  snapshot() {
    return { active: this.active, queued: this.queue.length, limit: this.limit };
  }
}

export class MemoryTileCache {
  constructor(maxBytes = DEFAULT_CACHE_BYTES, {
    ttlMs = DEFAULT_CACHE_TTL_MS,
    staleMs = DEFAULT_CACHE_STALE_MS,
    maxEntries = DEFAULT_CACHE_ENTRIES,
    now = () => Date.now()
  } = {}) {
    this.maxBytes = boundedInteger(maxBytes, DEFAULT_CACHE_BYTES, 1_024 * 1_024, 2 * 1_024 * 1_024 * 1_024);
    this.ttlMs = boundedInteger(ttlMs, DEFAULT_CACHE_TTL_MS, 1_000, 7 * 24 * 60 * 60 * 1_000);
    this.staleMs = boundedInteger(staleMs, DEFAULT_CACHE_STALE_MS, this.ttlMs, 30 * 24 * 60 * 60 * 1_000);
    this.maxEntries = boundedInteger(maxEntries, DEFAULT_CACHE_ENTRIES, 16, 100_000);
    this.now = now;
    this.size = 0;
    this.entries = new Map();
    this.hits = 0;
    this.staleHits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  touch(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  getFresh(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (this.now() > entry.freshUntil) return null;
    this.hits += 1;
    this.touch(key, entry);
    return Buffer.from(entry.data);
  }

  getStale(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() > entry.staleUntil) {
      this.delete(key);
      return null;
    }
    this.staleHits += 1;
    this.touch(key, entry);
    return Buffer.from(entry.data);
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.size -= entry.data.byteLength;
    return true;
  }

  set(key, value) {
    const data = Buffer.from(value);
    if (!data.byteLength || data.byteLength > this.maxBytes) return data;

    this.delete(key);
    const createdAt = this.now();
    this.entries.set(key, {
      data,
      createdAt,
      freshUntil: createdAt + this.ttlMs,
      staleUntil: createdAt + this.staleMs
    });
    this.size += data.byteLength;

    while (
      (this.size > this.maxBytes || this.entries.size > this.maxEntries) &&
      this.entries.size > 1
    ) {
      const oldestKey = this.entries.keys().next().value;
      this.delete(oldestKey);
      this.evictions += 1;
    }
    return Buffer.from(data);
  }

  snapshot() {
    return {
      entries: this.entries.size,
      bytes: this.size,
      maxBytes: this.maxBytes,
      hits: this.hits,
      staleHits: this.staleHits,
      misses: this.misses,
      evictions: this.evictions
    };
  }
}

function requireAssetName(value, label) {
  const asset = String(value || '');
  if (!/^occumed-[a-z0-9-]+\.pmtiles$/.test(asset)) {
    throw new Error(`The worldwide manifest has an invalid ${label} asset.`);
  }
  return asset;
}

function requireBounds(value, label) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`The worldwide manifest has invalid bounds for ${label}.`);
  }
  const bounds = value.map(Number);
  const [west, south, east, north] = bounds;
  if (
    !bounds.every(Number.isFinite) ||
    west < -180 || west > 180 || east < -180 || east > 180 ||
    south < -90 || south > 90 || north < -90 || north > 90 ||
    south >= north
  ) {
    throw new Error(`The worldwide manifest has invalid bounds for ${label}.`);
  }
  return bounds;
}

export function parseManifest(manifest, { maxRegions = DEFAULT_MAX_REGIONS } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('The worldwide manifest must be a JSON object.');
  }
  if (Number(manifest.version) !== 2) {
    throw new Error('The worldwide gateway requires the server-only version 2 manifest.');
  }
  if (!Array.isArray(manifest.regions) || !manifest.regions.length) {
    throw new Error('The worldwide manifest does not contain regional storage shards.');
  }
  if (manifest.regions.length > maxRegions) {
    throw new Error(`The worldwide manifest exceeds the ${maxRegions}-region safety limit.`);
  }
  if (Number(manifest.missingRegionCount || 0) !== 0) {
    throw new Error('The worldwide manifest still reports missing regional shards.');
  }

  const virtual = manifest.virtualTiles || {};
  if (virtual.endpoint !== '/tiles/{z}/{x}/{y}.pbf') {
    throw new Error('The worldwide manifest does not declare the permanent vector endpoint.');
  }
  const overviewAsset = requireAssetName(
    virtual.overviewAsset || DEFAULT_OVERVIEW_ASSET,
    'overview'
  );
  const surfaceAsset = requireAssetName(
    virtual.surfaceAsset || DEFAULT_SURFACE_ASSET,
    'surface'
  );
  const overviewMaxZoom = Number(virtual.overviewMaxZoom ?? DEFAULT_OVERVIEW_MAX_ZOOM);
  const surfaceMaxZoom = Number(virtual.surfaceMaxZoom ?? DEFAULT_SURFACE_MAX_ZOOM);
  const routingZoom = Number(virtual.routingZoom ?? DEFAULT_ROUTING_ZOOM);
  const maxZoom = Number(virtual.maxZoom ?? DEFAULT_MAX_ZOOM);

  for (const [label, value] of Object.entries({
    overviewMaxZoom,
    surfaceMaxZoom,
    routingZoom,
    maxZoom
  })) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 22) {
      throw new Error(`The worldwide manifest has an invalid ${label}.`);
    }
  }
  if (overviewMaxZoom + 1 !== routingZoom) {
    throw new Error('The worldwide overview and regional routing zooms must be exactly adjacent.');
  }
  if (surfaceMaxZoom > maxZoom) {
    throw new Error('The worldwide surface archive exceeds the virtual tileset maximum zoom.');
  }

  const ids = new Set();
  const assets = new Set([overviewAsset, surfaceAsset]);
  const regions = manifest.regions.map((region, index) => {
    const id = String(region?.id || '').trim();
    if (!id || id.length > 200) {
      throw new Error(`The worldwide manifest has an invalid regional ID at index ${index}.`);
    }
    if (ids.has(id)) throw new Error(`The worldwide manifest repeats regional ID ${id}.`);
    ids.add(id);

    const asset = requireAssetName(region.asset, `regional (${id})`);
    if (assets.has(asset)) throw new Error(`The worldwide manifest repeats asset ${asset}.`);
    assets.add(asset);

    return {
      ...region,
      id,
      asset,
      bounds: requireBounds(region.bounds, id)
    };
  });

  for (const [label, value] of Object.entries({
    plannedRegionCount: manifest.plannedRegionCount,
    availableRegionCount: manifest.availableRegionCount
  })) {
    if (value !== undefined && Number(value) !== regions.length) {
      throw new Error(`The worldwide manifest ${label} does not match its region inventory.`);
    }
  }

  return {
    ...manifest,
    regions,
    virtualTiles: {
      ...virtual,
      overviewAsset,
      surfaceAsset,
      overviewMaxZoom,
      surfaceMaxZoom,
      routingZoom,
      maxZoom,
      surfaceLayers: [...CONTINUOUS_SURFACE_LAYERS]
    }
  };
}

export class WorldTileGateway {
  constructor({
    manifestUrl,
    releaseAssetUrl,
    fetchImpl = fetch,
    cacheBytes = Number(process.env.OCCUMED_TILE_CACHE_MAX_BYTES || DEFAULT_CACHE_BYTES),
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    cacheStaleMs = DEFAULT_CACHE_STALE_MS,
    manifestTimeoutMs = DEFAULT_MANIFEST_TIMEOUT_MS,
    manifestTtlMs = DEFAULT_MANIFEST_TTL_MS,
    manifestStaleMs = DEFAULT_MANIFEST_STALE_MS,
    maxManifestBytes = DEFAULT_MAX_MANIFEST_BYTES,
    maxRegions = DEFAULT_MAX_REGIONS,
    maxTileFanout = DEFAULT_MAX_TILE_FANOUT,
    maxInflightTiles = DEFAULT_MAX_INFLIGHT_TILES,
    maxUpstreamTileBytes = DEFAULT_MAX_UPSTREAM_TILE_BYTES,
    maxResolvedTileBytes = DEFAULT_MAX_RESOLVED_TILE_BYTES,
    archiveReadConcurrency = DEFAULT_MAX_ARCHIVE_READS,
    archiveReadQueue = DEFAULT_MAX_ARCHIVE_QUEUE,
    overviewUrl = process.env.OCCUMED_WORLD_OVERVIEW_URL?.trim() || '',
    persistentTileCache = null,
    now = () => Date.now()
  }) {
    this.manifestUrl = validateHttpUrl(manifestUrl, 'The worldwide manifest URL');
    if (typeof releaseAssetUrl !== 'function') {
      throw new TypeError('WorldTileGateway requires a releaseAssetUrl function.');
    }
    this.releaseAssetUrl = releaseAssetUrl;
    this.fetchImpl = fetchImpl;
    this.overviewUrl = overviewUrl ? validateHttpUrl(overviewUrl, 'The overview URL') : '';
    this.persistentTileCache = persistentTileCache;
    this.now = now;
    this.manifestTimeoutMs = boundedInteger(manifestTimeoutMs, DEFAULT_MANIFEST_TIMEOUT_MS, 500, 60_000);
    this.manifestTtlMs = boundedInteger(manifestTtlMs, DEFAULT_MANIFEST_TTL_MS, 1_000, 24 * 60 * 60 * 1_000);
    this.manifestStaleMs = boundedInteger(manifestStaleMs, DEFAULT_MANIFEST_STALE_MS, this.manifestTtlMs, 30 * 24 * 60 * 60 * 1_000);
    this.maxManifestBytes = boundedInteger(maxManifestBytes, DEFAULT_MAX_MANIFEST_BYTES, 16_384, 32 * 1024 * 1024);
    this.maxRegions = boundedInteger(maxRegions, DEFAULT_MAX_REGIONS, 1, 10_000);
    this.maxTileFanout = boundedInteger(maxTileFanout, DEFAULT_MAX_TILE_FANOUT, 1, 256);
    this.maxInflightTiles = boundedInteger(maxInflightTiles, DEFAULT_MAX_INFLIGHT_TILES, 4, 2_048);
    this.maxUpstreamTileBytes = boundedInteger(maxUpstreamTileBytes, DEFAULT_MAX_UPSTREAM_TILE_BYTES, 1_024, 64 * 1024 * 1024);
    this.maxResolvedTileBytes = boundedInteger(maxResolvedTileBytes, DEFAULT_MAX_RESOLVED_TILE_BYTES, 1_024, 96 * 1024 * 1024);
    this.tileCache = new MemoryTileCache(cacheBytes, {
      ttlMs: cacheTtlMs,
      staleMs: cacheStaleMs,
      now
    });
    this.directoryCache = new SharedPromiseCache(4096);
    this.archiveReadLimiter = new AsyncLimiter(
      boundedInteger(archiveReadConcurrency, DEFAULT_MAX_ARCHIVE_READS, 1, 256),
      boundedInteger(archiveReadQueue, DEFAULT_MAX_ARCHIVE_QUEUE, 1, 4_096)
    );
    this.archives = new Map();
    this.sources = new Map();
    this.inflight = new Map();
    this.manifestPromise = null;
    this.manifestState = null;
    this.metrics = {
      resolved: 0,
      failed: 0,
      staleServed: 0,
      overloads: 0,
      missingSurface: 0,
      persistentHits: 0,
      persistentMisses: 0,
      persistentWrites: 0
    };
  }

  async fetchManifest() {
    const response = await this.fetchImpl(this.manifestUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Occu-Med-Map/virtual-world-tiles'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.manifestTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Worldwide manifest upstream returned ${response.status}.`);
    }
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxManifestBytes) {
      throw new Error('The worldwide manifest exceeds its maximum allowed size.');
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > this.maxManifestBytes) {
      throw new Error('The worldwide manifest exceeds its maximum allowed size.');
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw new Error('The worldwide manifest is not valid JSON.', { cause: error });
    }
    const manifest = parseManifest(document, { maxRegions: this.maxRegions });
    return {
      ...manifest,
      cacheVersion: createHash('sha256').update(text).digest('hex').slice(0, 32),
      routingIndex: new WorldTileRoutingIndex(manifest.regions, {
        routingZoom: manifest.virtualTiles.routingZoom,
        maxCellFanout: this.maxTileFanout
      })
    };
  }

  async loadManifest({ force = false } = {}) {
    const timestamp = this.now();
    if (!force && this.manifestState && timestamp <= this.manifestState.freshUntil) {
      return this.manifestState.manifest;
    }
    if (this.manifestPromise) return this.manifestPromise;

    const previous = this.manifestState;
    this.manifestPromise = this.fetchManifest()
      .then((manifest) => {
        const loadedAt = this.now();
        this.manifestState = {
          manifest,
          loadedAt,
          freshUntil: loadedAt + this.manifestTtlMs,
          staleUntil: loadedAt + this.manifestStaleMs
        };
        return manifest;
      })
      .catch((error) => {
        if (previous && this.now() <= previous.staleUntil) return previous.manifest;
        throw error;
      })
      .finally(() => {
        this.manifestPromise = null;
      });
    return this.manifestPromise;
  }

  archive(asset) {
    let archive = this.archives.get(asset);
    if (!archive) {
      const sourceUrl = asset === DEFAULT_OVERVIEW_ASSET && this.overviewUrl
        ? this.overviewUrl
        : validateHttpUrl(this.releaseAssetUrl(asset), `The release URL for ${asset}`);
      const source = new RetryingFetchSource(sourceUrl);
      archive = new PMTiles(source, this.directoryCache);
      this.sources.set(asset, source);
      this.archives.set(asset, archive);
    }
    return archive;
  }

  async readArchiveTile(asset, zoom, x, y) {
    return this.archiveReadLimiter.run(async () => {
      let result;
      try {
        result = await this.archive(asset).getZxy(zoom, x, y);
      } catch (error) {
        throw new Error(`Unable to read ${asset} tile ${zoom}/${x}/${y}.`, { cause: error });
      }
      if (!result?.data) return null;
      const payload = Buffer.from(result.data);
      if (!payload.byteLength || payload.byteLength > this.maxUpstreamTileBytes) {
        throw new Error(`${asset} returned an invalid ${payload.byteLength}-byte vector tile.`);
      }
      return payload;
    });
  }

  async readSurfaceTile(manifest, zoom, x, y) {
    const {
      surfaceAsset,
      surfaceMaxZoom
    } = manifest.virtualTiles;
    if (zoom <= surfaceMaxZoom) {
      const payload = await this.readArchiveTile(surfaceAsset, zoom, x, y);
      if (!payload) return EMPTY_MVT;
      const surface = mergeVectorTiles(
        [payload],
        { includeLayers: CONTINUOUS_SURFACE_LAYERS }
      );
      const landcoverFallback = copyVectorLayer(surface, {
        sourceLayerName: 'land',
        targetLayerName: 'landcover',
        propertyOverrides: LANDCOVER_FALLBACK_PROPERTIES
      });
      return mergeVectorTiles(
        [landcoverFallback, surface],
        { includeLayers: CONTINUOUS_SURFACE_LAYERS }
      );
    }

    const divisor = 2 ** (zoom - surfaceMaxZoom);
    const sourceX = Math.floor(x / divisor);
    const sourceY = Math.floor(y / divisor);
    const payload = await this.readArchiveTile(
      surfaceAsset,
      surfaceMaxZoom,
      sourceX,
      sourceY
    );
    if (!payload) return EMPTY_MVT;

    const overscaledLayers = CONTINUOUS_SURFACE_LAYERS.map((layerName) =>
      overscaleVectorLayer(payload, {
        layerName,
        sourceZoom: surfaceMaxZoom,
        targetZoom: zoom,
        targetX: x,
        targetY: y
      })
    );
    const landcoverFallback = copyVectorLayer(overscaledLayers[0], {
      sourceLayerName: 'land',
      targetLayerName: 'landcover',
      propertyOverrides: LANDCOVER_FALLBACK_PROPERTIES
    });
    return mergeVectorTiles([landcoverFallback, ...overscaledLayers]);
  }

  async readBasemapTile(manifest, zoom, x, y) {
    const {
      overviewAsset,
      overviewMaxZoom
    } = manifest.virtualTiles;
    if (zoom <= overviewMaxZoom) {
      const payload = await this.readArchiveTile(overviewAsset, zoom, x, y);
      return payload || EMPTY_MVT;
    }

    const regions = manifest.routingIndex.regionsForTile(zoom, x, y);
    if (!regions.length) return EMPTY_MVT;
    if (regions.length > this.maxTileFanout) {
      throw new Error(`Tile ${zoom}/${x}/${y} exceeds the ${this.maxTileFanout}-shard fan-out limit.`);
    }

    const settled = await Promise.allSettled(
      regions.map((region) => this.readArchiveTile(region.asset, zoom, x, y))
    );
    const failures = settled
      .map((result, index) => ({ result, region: regions[index] }))
      .filter(({ result }) => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(
        failures.map(({ result }) => result.reason),
        `Tile ${zoom}/${x}/${y} failed to read ${failures.length} of ${regions.length} required shards.`
      );
    }

    const payloads = settled
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => result.value);
    return payloads.length ? mergeVectorTiles(payloads) : EMPTY_MVT;
  }

  async buildTile(manifest, zoom, x, y) {
    if (zoom > manifest.virtualTiles.maxZoom) {
      throw new RangeError(`Tile zoom ${zoom} exceeds the worldwide maximum zoom.`);
    }
    const [surface, basemap] = await Promise.all([
      this.readSurfaceTile(manifest, zoom, x, y),
      this.readBasemapTile(manifest, zoom, x, y)
    ]);

    if (Buffer.from(surface).equals(EMPTY_MVT)) {
      this.metrics.missingSurface += 1;
      const error = new Error(`The authoritative physical surface is missing tile ${zoom}/${x}/${y}.`);
      error.code = 'OCCUMED_SURFACE_TILE_MISSING';
      throw error;
    }

    const cartography = mergeVectorTiles([basemap], {
      excludeLayers: CONTINUOUS_SURFACE_LAYERS
    });
    const tile = mergeVectorTiles([surface, cartography], { coordinateScale: 128 });
    if (!tile.byteLength || tile.byteLength > this.maxResolvedTileBytes) {
      throw new Error(`Resolved tile ${zoom}/${x}/${y} has unsafe size ${tile.byteLength}.`);
    }
    return tile;
  }

  async resolveTile(zoom, x, y) {
    const coordinates = normalizeTileCoordinates(zoom, x, y, 22);
    if (!coordinates) throw new RangeError('Invalid worldwide tile coordinates.');
    const key = `${coordinates.z}/${coordinates.x}/${coordinates.y}`;
    const fresh = this.tileCache.getFresh(key);
    if (fresh) return fresh;
    const stale = this.tileCache.getStale(key);
    if (this.inflight.has(key)) return this.inflight.get(key);
    if (this.inflight.size >= this.maxInflightTiles) {
      this.metrics.overloads += 1;
      if (stale) {
        this.metrics.staleServed += 1;
        return stale;
      }
      throw new GatewayOverloadedError('The worldwide tile gateway has reached its in-flight limit.');
    }

    const promise = this.loadManifest()
      .then(async (manifest) => {
        if (this.persistentTileCache) {
          const persisted = await this.persistentTileCache.get(
            manifest.cacheVersion,
            coordinates.z,
            coordinates.x,
            coordinates.y
          );
          if (
            persisted?.byteLength > 0 &&
            persisted.byteLength <= this.maxResolvedTileBytes
          ) {
            this.metrics.persistentHits += 1;
            return { tile: persisted, manifest, built: false };
          }
          this.metrics.persistentMisses += 1;
        }

        const tile = await this.buildTile(
          manifest,
          coordinates.z,
          coordinates.x,
          coordinates.y
        );
        return { tile, manifest, built: true };
      })
      .then(({ tile, manifest, built }) => {
        this.metrics.resolved += 1;
        const cached = this.tileCache.set(key, tile);
        if (built && this.persistentTileCache) {
          void this.persistentTileCache.set(
            manifest.cacheVersion,
            coordinates.z,
            coordinates.x,
            coordinates.y,
            cached
          ).then((written) => {
            if (written) this.metrics.persistentWrites += 1;
          }).catch(() => {});
        }
        return cached;
      })
      .catch((error) => {
        this.metrics.failed += 1;
        if (stale) {
          this.metrics.staleServed += 1;
          return stale;
        }
        throw error;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  async initializePersistentCache() {
    return this.persistentTileCache?.initialize
      ? this.persistentTileCache.initialize()
      : 0;
  }

  async close() {
    await this.persistentTileCache?.close?.();
  }

  async ready() {
    const manifest = await this.loadManifest();
    return {
      ready: true,
      regions: manifest.regions.length,
      maxZoom: manifest.virtualTiles.maxZoom
    };
  }

  getHealthSnapshot() {
    return {
      manifest: this.manifestState
        ? {
            loadedAt: this.manifestState.loadedAt,
            freshUntil: this.manifestState.freshUntil,
            staleUntil: this.manifestState.staleUntil,
            regions: this.manifestState.manifest.regions.length,
            cacheVersion: this.manifestState.manifest.cacheVersion
          }
        : null,
      cache: this.tileCache.snapshot(),
      persistentCache: this.persistentTileCache?.snapshot?.() || { enabled: false },
      archiveReads: this.archiveReadLimiter.snapshot(),
      inflightTiles: this.inflight.size,
      archives: this.archives.size,
      metrics: { ...this.metrics },
      sources: [...this.sources.entries()].map(([asset, source]) => ({
        asset,
        ...source.getHealthSnapshot()
      }))
    };
  }
}
