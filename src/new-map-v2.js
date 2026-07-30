import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const SOURCE_ID = 'occumed-world-topographic';
const TILE_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
const WORLD_BOUNDS = [[-179.8, -78], [179.8, 82]];

const STYLE = Object.freeze({
  version: 8,
  name: 'Occu-Med Worldwide Topographic',
  projection: { type: 'mercator' },
  metadata: {
    'occumed:architecture': 'world-topographic-raster-v3',
    'occumed:projection': 'mercator',
    'occumed:source-count': 1,
    'occumed:runtime-merge': false,
    'occumed:regional-routing': false,
    'occumed:neon': false,
    'occumed:reference-style': 'world-topographic-relief'
  },
  sources: {
    [SOURCE_ID]: {
      type: 'raster',
      tiles: [TILE_URL],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 19,
      attribution: 'Sources: Esri and data providers'
    }
  },
  layers: [
    {
      id: 'occumed-water-background',
      type: 'background',
      paint: {
        'background-color': '#79BCEC',
        'background-opacity': 1
      }
    },
    {
      id: 'occumed-world-topographic-map',
      type: 'raster',
      source: SOURCE_ID,
      minzoom: 0,
      maxzoom: 20,
      paint: {
        'raster-opacity': 1,
        'raster-fade-duration': 0,
        'raster-resampling': 'linear'
      }
    }
  ]
});

function setStatus(message, state = 'loading') {
  const element = document.querySelector('#map-status');
  if (element) element.textContent = message;
  document.documentElement.dataset.mapState = state;
}

function waitForIdle(map, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The worldwide topographic map did not become idle in time.')), timeoutMs);
    const complete = () => {
      if (!map.loaded() || !map.areTilesLoaded()) return;
      clearTimeout(timeout);
      map.off('idle', complete);
      resolve();
    };
    map.on('idle', complete);
    complete();
  });
}

export async function startOccumedMapV2() {
  setStatus('Loading worldwide topographic map…');
  const errors = [];
  const style = structuredClone(STYLE);

  const map = new maplibregl.Map({
    container: 'map',
    style,
    center: [0, 18],
    zoom: 1.15,
    minZoom: 0,
    maxZoom: 19,
    pitch: 0,
    bearing: 0,
    hash: false,
    antialias: true,
    renderWorldCopies: false,
    refreshExpiredTiles: false,
    fadeDuration: 0,
    attributionControl: false,
    cooperativeGestures: false,
    maxTileCacheZoomLevels: 8
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  map.on('error', (event) => {
    const message = event?.error?.message || event?.message || 'Unknown map error';
    errors.push(message);
    console.warn('Occu-Med topographic map resource warning:', message);
  });

  map.once('load', () => {
    map.fitBounds(WORLD_BOUNDS, { padding: 12, duration: 0, maxZoom: 2.15 });
  });

  globalThis.__OCCUMED_MAP__ = map;
  globalThis.__OCCUMED_MAP_V2__ = {
    ready: false,
    sourceId: SOURCE_ID,
    sourceCount: 1,
    sourceType: 'raster',
    projection: 'mercator',
    architecture: 'world-topographic-raster-v3',
    tileUrl: TILE_URL,
    errors
  };

  await waitForIdle(map);
  const sourceLoaded = map.isSourceLoaded(SOURCE_ID);
  const contract = globalThis.__OCCUMED_MAP_V2__;
  Object.assign(contract, {
    ready: true,
    sourceLoaded,
    zoom: map.getZoom(),
    center: map.getCenter().toArray(),
    tilesLoaded: map.areTilesLoaded()
  });

  if (!sourceLoaded || !map.areTilesLoaded()) {
    throw new Error('The worldwide topographic source did not finish loading.');
  }

  setStatus('Occu-Med map ready', 'ready');
  document.documentElement.classList.add('map-is-ready');
  return map;
}
