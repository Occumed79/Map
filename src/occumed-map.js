import * as maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { installWorldPmtilesRouter } from './world-pmtiles-router.js';

export const DEFAULT_STYLE_URL = '/style/occumed-open.json';

const MIN_RENDER_PIXEL_RATIO = 2;
const MAX_RENDER_PIXEL_RATIO = 3;
const pmtilesProtocol = new Protocol();
let protocolRegistered = false;

function ensurePmtilesProtocol() {
  if (protocolRegistered) return;
  maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
  protocolRegistered = true;
}

export function resolveOccumedPixelRatio() {
  const deviceRatio = Number(globalThis.devicePixelRatio);
  if (!Number.isFinite(deviceRatio) || deviceRatio <= 0) return MIN_RENDER_PIXEL_RATIO;
  return Math.min(Math.max(deviceRatio, MIN_RENDER_PIXEL_RATIO), MAX_RENDER_PIXEL_RATIO);
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
  }

  if (typeof resolved.metadata?.['occumed:world-manifest-url'] === 'string') {
    resolved.metadata['occumed:world-manifest-url'] = resolved.metadata['occumed:world-manifest-url']
      .replaceAll('__OCCUMED_PUBLIC_ORIGIN__', styleOrigin);
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
  zoom = 1.82,
  minZoom = 0,
  maxZoom = 19,
  controls = true,
  scaleControl = false,
  mapOptions = {}
}) {
  if (!container) {
    throw new TypeError('createOccumedMap requires a map container.');
  }

  ensurePmtilesProtocol();
  const style = await loadOccumedStyle(styleUrl);
  const fallbackUrl = style.sources?.['occumed-open']?.url;
  const manifestUrl = style.metadata?.['occumed:world-manifest-url'];
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
    renderWorldCopies: false,
    attributionControl: false,
    cooperativeGestures: false,
    ...mapOptions
  });

  map.occumedWorldRouter = installWorldPmtilesRouter(map, {
    manifestUrl,
    fallbackUrl
  });

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
