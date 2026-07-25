import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export const DEFAULT_STYLE_URL = '/style/occumed-open.json';

function resolvePublicOrigin(style, styleUrl) {
  const resolved = structuredClone(style);
  const styleOrigin = new URL(styleUrl, window.location.href).origin;

  if (typeof resolved.sprite === 'string') {
    resolved.sprite = resolved.sprite.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', styleOrigin);
  }

  return resolved;
}

export async function loadOccumedStyle(styleUrl = DEFAULT_STYLE_URL) {
  const response = await fetch(styleUrl, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Unable to load the Occu-Med style (${response.status}).`);
  }

  return resolvePublicOrigin(await response.json(), styleUrl);
}

/**
 * Creates one independent map instance using the shared Occu-Med basemap.
 *
 * This package intentionally contains no provider, employer, procurement,
 * clinic, opportunity, or other application-specific overlay data. Each app
 * owns and adds its own sources and layers after the map is created.
 */
export async function createOccumedMap({
  container,
  styleUrl = DEFAULT_STYLE_URL,
  center = [-98.5, 39.5],
  zoom = 3.3,
  minZoom = 1,
  maxZoom = 19,
  controls = true,
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
    hash: false,
    attributionControl: true,
    cooperativeGestures: false,
    ...mapOptions
  });

  if (controls) {
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
  }

  return map;
}

export { maplibregl };
