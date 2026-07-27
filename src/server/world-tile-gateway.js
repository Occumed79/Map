import { PMTiles, SharedPromiseCache } from 'pmtiles';
import {
  EMPTY_MVT,
  mergeVectorTiles,
  overscaleVectorLayer
} from './mvt.js';
import { RetryingFetchSource } from './pmtiles-source.js';
import { WorldTileRoutingIndex } from './world-tile-routing.js';

const DEFAULT_OVERVIEW_ASSET = 'occumed-world-overview.pmtiles';
const DEFAULT_SURFACE_ASSET = 'occumed-world-surface.pmtiles';
const DEFAULT_OVERVIEW_MAX_ZOOM = 5;
const DEFAULT_SURFACE_MAX_ZOOM = 10;
const DEFAULT_ROUTING_ZOOM = 6;
const DEFAULT_MAX_ZOOM = 16;
const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;

class MemoryTileCache {
  constructor(maxBytes = DEFAULT_CACHE_BYTES) {
    this.maxBytes = maxBytes;
    this.size = 0;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key, value) {
    const data = Buffer.from(value);
    const existing = this.entries.get(key);
    if (existing) {
      this.size -= existing.byteLength;
      this.entries.delete(key);
    }

    this.entries.set(key, data);
    this.size += data.byteLength;
    while (this.size > this.maxBytes && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.size -= oldest.byteLength;
    }
    return data;
  }
}

function requireAssetName(value, label) {
  const asset = String(value || '');
  if (!/^occumed-[a-z0-9-]+\.pmtiles$/.test(asset)) {
    throw new Error(`The worldwide manifest has an invalid ${label} asset.`);
  }
  return asset;
}

function parseManifest(manifest) {
  if (Number(manifest?.version) !== 2) {
    throw new Error('The worldwide gateway requires the server-only version 2 manifest.');
  }
  if (!manifest || !Array.isArray(manifest.regions) || !manifest.regions.length) {
    throw new Error('The worldwide manifest does not contain regional storage shards.');
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
  if (overviewMaxZoom >= routingZoom) {
    throw new Error('The worldwide overview must end before regional routing begins.');
  }
  if (surfaceMaxZoom > maxZoom) {
    throw new Error('The worldwide surface archive exceeds the virtual tileset maximum zoom.');
  }

  const regions = manifest.regions.map((region) => ({
    ...region,
    asset: requireAssetName(region.asset, `regional (${region.id || 'unknown'})`)
  }));

  return {
    ...manifest,
    regions,
    virtualTiles: {
      overviewAsset,
      surfaceAsset,
      overviewMaxZoom,
      surfaceMaxZoom,
      routingZoom,
      maxZoom
    }
  };
}

export class WorldTileGateway {
  constructor({
    manifestUrl,
    releaseAssetUrl,
    fetchImpl = fetch,
    cacheBytes = Number(process.env.OCCUMED_TILE_CACHE_MAX_BYTES || DEFAULT_CACHE_BYTES)
  }) {
    this.manifestUrl = manifestUrl;
    this.releaseAssetUrl = releaseAssetUrl;
    this.fetchImpl = fetchImpl;
    this.tileCache = new MemoryTileCache(cacheBytes);
    this.directoryCache = new SharedPromiseCache(4096);
    this.archives = new Map();
    this.inflight = new Map();
    this.manifestPromise = null;
  }

  async loadManifest() {
    if (!this.manifestPromise) {
      this.manifestPromise = this.fetchImpl(this.manifestUrl, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Occu-Med-Map/virtual-world-tiles'
        },
        redirect: 'follow'
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Worldwide manifest upstream returned ${response.status}.`);
        }
        const manifest = parseManifest(await response.json());
        return {
          ...manifest,
          routingIndex: new WorldTileRoutingIndex(manifest.regions, {
            routingZoom: manifest.virtualTiles.routingZoom
          })
        };
      }).catch((error) => {
        this.manifestPromise = null;
        throw error;
      });
    }
    return this.manifestPromise;
  }

  archive(asset) {
    let archive = this.archives.get(asset);
    if (!archive) {
      archive = new PMTiles(
        new RetryingFetchSource(this.releaseAssetUrl(asset)),
        this.directoryCache
      );
      this.archives.set(asset, archive);
    }
    return archive;
  }

  async readArchiveTile(asset, zoom, x, y) {
    const result = await this.archive(asset).getZxy(zoom, x, y);
    return result?.data ? Buffer.from(result.data) : null;
  }

  async readSurfaceTile(manifest, zoom, x, y) {
    const {
      surfaceAsset,
      surfaceMaxZoom
    } = manifest.virtualTiles;
    if (zoom <= surfaceMaxZoom) {
      const payload = await this.readArchiveTile(surfaceAsset, zoom, x, y);
      return payload
        ? mergeVectorTiles([payload], { includeLayers: ['land'] })
        : EMPTY_MVT;
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

    return overscaleVectorLayer(payload, {
      layerName: 'land',
      sourceZoom: surfaceMaxZoom,
      targetZoom: zoom,
      targetX: x,
      targetY: y
    });
  }

  async readBasemapTile(manifest, zoom, x, y) {
    const {
      overviewAsset,
      overviewMaxZoom
    } = manifest.virtualTiles;
    if (zoom <= overviewMaxZoom) {
      const payload = await this.readArchiveTile(overviewAsset, zoom, x, y);
      if (!payload) {
        throw new Error(`Worldwide overview is missing tile ${zoom}/${x}/${y}.`);
      }
      return payload;
    }

    const regions = manifest.routingIndex.regionsForTile(zoom, x, y);
    if (!regions.length) return EMPTY_MVT;

    const payloads = await Promise.all(
      regions.map((region) => this.readArchiveTile(region.asset, zoom, x, y))
    );
    return mergeVectorTiles(payloads);
  }

  async resolveTile(zoom, x, y) {
    const key = `${zoom}/${x}/${y}`;
    const cached = this.tileCache.get(key);
    if (cached) return cached;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const promise = this.loadManifest()
      .then(async (manifest) => {
        const [surface, basemap] = await Promise.all([
          this.readSurfaceTile(manifest, zoom, x, y),
          this.readBasemapTile(manifest, zoom, x, y)
        ]);
        return this.tileCache.set(
          key,
          mergeVectorTiles([surface, basemap], { coordinateScale: 128 })
        );
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }
}
