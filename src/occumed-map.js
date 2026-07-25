import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

export const DEFAULT_STYLE_URL = '/style.json';

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
    throw new Error(`Unable to load the uploaded Occu-Med style (${response.status}).`);
  }

  return response.json();
}

/**
 * Creates one independent Mapbox map instance from the untouched Occu-Med
 * Terrain export hosted by this service. Each consuming application adds and
 * owns its own overlay sources and layers after the basemap loads.
 */
export async function createOccumedMap({
  container,
  accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN,
  styleUrl = DEFAULT_STYLE_URL,
  center,
  zoom,
  bearing,
  pitch,
  controls = true,
  mapOptions = {}
}) {
  if (!container) {
    throw new TypeError('createOccumedMap requires a map container.');
  }

  const token = accessToken?.trim();
  if (!token) {
    throw new Error('VITE_MAPBOX_ACCESS_TOKEN is required to render the original Mapbox data, fonts, and sprite.');
  }

  mapboxgl.accessToken = token;
  const style = await loadOccumedStyle(styleUrl);

  const map = new mapboxgl.Map({
    container,
    style,
    center: center ?? style.center ?? [-98.5, 24],
    zoom: zoom ?? style.zoom ?? 2.43,
    bearing: bearing ?? style.bearing ?? 0,
    pitch: pitch ?? style.pitch ?? 0,
    hash: false,
    antialias: true,
    attributionControl: false,
    cooperativeGestures: false,
    ...mapOptions
  });

  if (controls) {
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
  }

  map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
  return map;
}

export { mapboxgl };
