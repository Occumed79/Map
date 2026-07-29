import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export const DEFAULT_STYLE_URL = '/style/occumed-open.json';

const MIN_RENDER_PIXEL_RATIO = 2;
const MAX_RENDER_PIXEL_RATIO = 3;
const GLOBE_TILE_SIZE = 512;
const GLOBE_CIRCUMFERENCE = Math.PI * 2;
const BLOOM_FADE_START_ZOOM = 2.85;
const BLOOM_FADE_END_ZOOM = 4.25;
const WORLD_MIN_ZOOM = 0;
const WORLD_MAX_ZOOM = 16;
const WORLD_ZOOM_PYRAMID_LEVELS = WORLD_MAX_ZOOM - WORLD_MIN_ZOOM + 1;

export function resolveOccumedPixelRatio() {
  const deviceRatio = Number(globalThis.devicePixelRatio);
  if (!Number.isFinite(deviceRatio) || deviceRatio <= 0) return MIN_RENDER_PIXEL_RATIO;
  return Math.min(Math.max(deviceRatio, MIN_RENDER_PIXEL_RATIO), MAX_RENDER_PIXEL_RATIO);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function resolveGlobeBloomOpacity(zoom) {
  if (zoom <= BLOOM_FADE_START_ZOOM) return 1;
  if (zoom >= BLOOM_FADE_END_ZOOM) return 0;
  return 1 - clamp01(
    (zoom - BLOOM_FADE_START_ZOOM) /
    (BLOOM_FADE_END_ZOOM - BLOOM_FADE_START_ZOOM)
  );
}

function resolveGlobeRadius(zoom) {
  return (GLOBE_TILE_SIZE * (2 ** zoom)) / GLOBE_CIRCUMFERENCE;
}

/**
 * Adds a true outward atmosphere bloom around the globe limb.
 *
 * MapLibre's sky properties provide the crisp horizon rim, but increasing their
 * blend values also brightens the visible hemisphere. This DOM halo tracks the
 * rendered globe radius and adds only an exterior white-blue bloom, leaving the
 * map surface neutral. It fades away before the projection reads as a regional
 * map rather than a complete globe.
 */
export function installOccumedAtmosphereBloom(map) {
  const canvasContainer = map.getCanvasContainer();
  const existing = canvasContainer.querySelector('.occumed-atmosphere-bloom');
  if (existing) return existing;

  const bloom = document.createElement('div');
  bloom.className = 'occumed-atmosphere-bloom';
  bloom.setAttribute('aria-hidden', 'true');
  canvasContainer.append(bloom);

  let removed = false;

  const update = () => {
    if (removed) return;
    const zoom = map.getZoom();
    const center = map.project(map.getCenter());
    const radius = resolveGlobeRadius(zoom);
    const opacity = resolveGlobeBloomOpacity(zoom);

    bloom.style.setProperty('--occumed-globe-bloom-x', `${center.x.toFixed(2)}px`);
    bloom.style.setProperty('--occumed-globe-bloom-y', `${center.y.toFixed(2)}px`);
    bloom.style.setProperty('--occumed-globe-diameter', `${(radius * 2).toFixed(2)}px`);
    bloom.style.setProperty('--occumed-globe-bloom-opacity', opacity.toFixed(3));
    bloom.hidden = opacity <= 0.001;
  };

  const trackedEvents = ['render', 'move', 'zoom', 'resize', 'moveend', 'zoomend'];
  for (const eventName of trackedEvents) map.on(eventName, update);

  const remove = () => {
    removed = true;
    for (const eventName of trackedEvents) map.off(eventName, update);
    bloom.remove();
  };

  map.once('remove', remove);
  update();
  return bloom;
}

/**
 * Keeps decoded substitute tiles renderable across the complete 0–16 pyramid.
 *
 * MapLibre's normal retention only searches in-view tiles while an ideal tile
 * is loading. Fully decoded parents and children in its out-of-view cache are
 * consequently skipped, leaving no renderable tile until the ideal request is
 * parsed. Keep the same-source global foundation decoded as a last resort and
 * reattach the nearest cached substitute before cleanup removes it.
 */
export function installContinuousTileRetention(map) {
  let removed = false;

  const configure = () => {
    if (removed) return;
    const tileManager = map.style?.tileManagers?.['occumed-open'];
    if (!tileManager?.constructor) return;
    tileManager.constructor.maxUnderzooming = Math.max(
      Number(tileManager.constructor.maxUnderzooming || 0),
      WORLD_ZOOM_PYRAMID_LEVELS
    );
    tileManager.constructor.maxOverzooming = Math.max(
      Number(tileManager.constructor.maxOverzooming || 0),
      WORLD_ZOOM_PYRAMID_LEVELS
    );
    if (tileManager.__occumedContinuousRetention) return;

    const updateRetainedTiles = tileManager._updateRetainedTiles.bind(tileManager);
    let globalFoundationID = null;
    tileManager._updateRetainedTiles = function retainCachedFoundation(idealTileIDs, zoom) {
      const retained = updateRetainedTiles(idealTileIDs, zoom);
      if (idealTileIDs.length && !globalFoundationID) {
        globalFoundationID = idealTileIDs[0].scaledTo(0);
      }
      if (globalFoundationID) {
        this._addTile(globalFoundationID);
        retained[globalFoundationID.key] = globalFoundationID;
      }

      for (const idealID of idealTileIDs) {
        if (this.getTileByID(idealID.key)?.hasData()) continue;

        let foundAncestor = false;
        for (let parentZoom = idealID.overscaledZ - 1; parentZoom >= 0; parentZoom -= 1) {
          const parentID = idealID.scaledTo(parentZoom);
          let parent = this.getTileByID(parentID.key);
          if (!parent && this._outOfViewCache.has(parentID)) {
            parent = this._addTile(parentID);
          }
          if (parent?.hasData()) {
            retained[parentID.key] = parentID;
            foundAncestor = true;
            break;
          }
        }
        if (foundAncestor) continue;

        const cachedChildren = Object.values(this._outOfViewCache.data)
          .flat()
          .map(({ value }) => value)
          .filter((tile) =>
            tile.hasData() &&
            tile.tileID.isChildOf(idealID) &&
            tile.tileID.overscaledZ - idealID.overscaledZ <= WORLD_ZOOM_PYRAMID_LEVELS
          )
          .map((tile) => tile.tileID.clone());
        if (!cachedChildren.length) continue;

        const nearestZoom = Math.min(...cachedChildren.map((tileID) => tileID.overscaledZ));
        for (const childID of cachedChildren) {
          if (childID.overscaledZ !== nearestZoom) continue;
          const child = this._addTile(childID);
          if (child.hasData()) retained[childID.key] = childID;
        }
      }

      return retained;
    };
    tileManager.__occumedContinuousRetention = true;
  };

  const remove = () => {
    removed = true;
    map.off('styledata', configure);
  };

  map.on('styledata', configure);
  map.once('remove', remove);
  configure();
}

function resolvePublicOrigin(style, styleUrl) {
  const resolved = structuredClone(style);
  const styleOrigin = new URL(styleUrl, window.location.href).origin;

  if (typeof resolved.sprite === 'string') {
    resolved.sprite = resolved.sprite.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', styleOrigin);
  }

  for (const source of Object.values(resolved.sources || {})) {
    if (typeof source?.url === 'string') {
      source.url = source.url.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', styleOrigin);
    }
    if (Array.isArray(source?.tiles)) {
      source.tiles = source.tiles.map((tileUrl) =>
        typeof tileUrl === 'string'
          ? tileUrl.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', styleOrigin)
          : tileUrl
      );
    }
  }

  return resolved;
}

function versionedStyleUrl(styleUrl) {
  const url = new URL(styleUrl, window.location.href);
  url.searchParams.set('__occumed_style', String(Date.now()));
  return url.href;
}

export async function loadOccumedStyle(styleUrl = DEFAULT_STYLE_URL) {
  const requestUrl = versionedStyleUrl(styleUrl);
  const response = await fetch(requestUrl, {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache'
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to load the Occu-Med style (${response.status}).`);
  }

  return resolvePublicOrigin(await response.json(), requestUrl);
}

/**
 * Creates one independent map instance using the shared Occu-Med basemap.
 * Each application adds and owns its own overlay sources and layers.
 */
export async function createOccumedMap({
  container,
  styleUrl = DEFAULT_STYLE_URL,
  center = [-98.5, 25],
  zoom = 2.43,
  minZoom = WORLD_MIN_ZOOM,
  maxZoom = WORLD_MAX_ZOOM,
  controls = true,
  scaleControl = false,
  mapOptions = {}
}) {
  if (!container) {
    throw new TypeError('createOccumedMap requires a map container.');
  }

  const style = await loadOccumedStyle(styleUrl);
  const map = new maplibregl.Map({
    container,
    style,
    center,
    zoom,
    minZoom,
    maxZoom,
    pitch: 0,
    bearing: 0,
    hash: false,
    pixelRatio: resolveOccumedPixelRatio(),
    antialias: true,
    // MapLibre only retains pending smaller-zoom requests during zoom-in when
    // cancellation is disabled. Reverse zooms also require the already-loaded
    // parent pyramid to remain in cache, so retain every zoom level from 0–16.
    cancelPendingTileRequestsWhileZooming: false,
    maxTileCacheZoomLevels: WORLD_ZOOM_PYRAMID_LEVELS,
    refreshExpiredTiles: false,
    fadeDuration: 300,
    renderWorldCopies: false,
    attributionControl: false,
    cooperativeGestures: false,
    ...mapOptions
  });

  installContinuousTileRetention(map);
  installOccumedAtmosphereBloom(map);

  if (controls) {
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  }

  if (scaleControl) {
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
  }

  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  return map;
}

export { maplibregl };
