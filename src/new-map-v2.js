import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const WORLD_BOUNDS = [[-179.8, -78], [179.8, 82]];
const PALETTE = Object.freeze({
  water: '#79BCEC',
  waterDeep: '#5EA9DF',
  land: '#C1DAAB',
  landSoft: '#D4E3C1',
  park: '#A5CC8E',
  parkDark: '#91BD78',
  road: '#F2F2F2',
  roadCasing: '#D5D7D8',
  boundary: '#A65966',
  building: '#DDD8CC',
  text: '#27313A',
  waterText: '#286E99',
  parkText: '#3D6D45',
  halo: '#F5FDFF'
});

function setStatus(message, state = 'loading') {
  const element = document.querySelector('#map-status');
  if (element) element.textContent = message;
  document.documentElement.dataset.mapState = state;
}

async function fetchStyle(attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`${STYLE_URL}?occumed=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) throw new Error(`Worldwide style returned HTTP ${response.status}.`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 800));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Unable to load the worldwide vector style.');
}

function textKey(layer) {
  return `${layer.id || ''} ${layer['source-layer'] || ''}`.toLowerCase();
}

function isWater(key) {
  return /water|ocean|lake|river|marine|bay/.test(key);
}

function isPark(key) {
  return /park|grass|wood|forest|landcover|landuse|nature|green|garden|golf|pitch|cemetery/.test(key);
}

function isRoad(key) {
  return /road|street|transport|motorway|trunk|primary|secondary|tertiary|minor|path|bridge|tunnel|rail/.test(key);
}

function isBoundary(key) {
  return /boundary|admin|border/.test(key);
}

function recolorLayer(layer) {
  const next = structuredClone(layer);
  const key = textKey(next);
  next.paint = { ...(next.paint || {}) };

  if (next.type === 'background') {
    next.paint['background-color'] = PALETTE.land;
    next.paint['background-opacity'] = 1;
    return next;
  }

  if (next.type === 'fill') {
    if (isWater(key)) {
      next.paint['fill-color'] = PALETTE.water;
      next.paint['fill-opacity'] = 1;
    } else if (isPark(key)) {
      next.paint['fill-color'] = /wood|forest/.test(key) ? PALETTE.parkDark : PALETTE.park;
      next.paint['fill-opacity'] = 0.86;
    } else if (/building/.test(key)) {
      next.paint['fill-color'] = PALETTE.building;
      next.paint['fill-opacity'] = 0.9;
    } else {
      next.paint['fill-color'] = /residential|suburb|neighbourhood|industrial|commercial/.test(key)
        ? PALETTE.landSoft
        : PALETTE.land;
      next.paint['fill-opacity'] = 1;
    }
    if ('fill-outline-color' in next.paint) next.paint['fill-outline-color'] = 'rgba(0,0,0,0.08)';
    return next;
  }

  if (next.type === 'line') {
    if (isBoundary(key)) {
      next.paint['line-color'] = PALETTE.boundary;
      next.paint['line-opacity'] = 0.82;
    } else if (isWater(key)) {
      next.paint['line-color'] = PALETTE.waterDeep;
      next.paint['line-opacity'] = 0.92;
    } else if (isRoad(key)) {
      next.paint['line-color'] = /case|casing|outline/.test(key) ? PALETTE.roadCasing : PALETTE.road;
      next.paint['line-opacity'] = 0.98;
    }
    return next;
  }

  if (next.type === 'symbol') {
    if (next.layout?.['text-field']) {
      next.paint['text-color'] = isWater(key) ? PALETTE.waterText : isPark(key) ? PALETTE.parkText : PALETTE.text;
      next.paint['text-halo-color'] = PALETTE.halo;
      next.paint['text-halo-width'] = 1.2;
      next.paint['text-halo-blur'] = 0.35;
    }
    return next;
  }

  return next;
}

function buildOccumedStyle(rawStyle) {
  const style = structuredClone(rawStyle);
  const vectorSources = Object.entries(style.sources || {}).filter(([, source]) => source?.type === 'vector');
  if (vectorSources.length !== 1) {
    throw new Error(`The replacement map requires exactly one worldwide vector source; received ${vectorSources.length}.`);
  }

  const [sourceId, source] = vectorSources[0];
  style.sources = { [sourceId]: source };
  style.layers = (style.layers || [])
    .filter((layer) => !layer.source || layer.source === sourceId)
    .filter((layer) => !['sky', 'hillshade', 'model', 'fill-extrusion'].includes(layer.type))
    .map(recolorLayer);
  style.projection = { type: 'mercator' };
  delete style.terrain;
  delete style.fog;
  delete style.light;
  style.metadata = {
    ...(style.metadata || {}),
    'occumed:architecture': 'clean-worldwide-vector-v2',
    'occumed:projection': 'mercator',
    'occumed:source-count': 1,
    'occumed:runtime-merge': false,
    'occumed:regional-routing': false,
    'occumed:neon': false
  };
  return { style, sourceId };
}

function waitForIdle(map, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The worldwide map did not become idle in time.')), timeoutMs);
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
  setStatus('Loading worldwide map…');
  const rawStyle = await fetchStyle();
  const { style, sourceId } = buildOccumedStyle(rawStyle);
  const errors = [];

  const map = new maplibregl.Map({
    container: 'map',
    style,
    center: [0, 20],
    zoom: 1.35,
    minZoom: 1,
    maxZoom: 18,
    pitch: 0,
    bearing: 0,
    hash: false,
    antialias: true,
    renderWorldCopies: false,
    refreshExpiredTiles: false,
    fadeDuration: 120,
    attributionControl: false,
    cooperativeGestures: false,
    maxTileCacheZoomLevels: 8
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  map.on('error', (event) => {
    const message = event?.error?.message || event?.message || 'Unknown map error';
    errors.push(message);
    console.warn('Occu-Med map resource warning:', message);
  });

  map.once('load', () => {
    map.fitBounds(WORLD_BOUNDS, { padding: 18, duration: 0, maxZoom: 2.2 });
  });

  globalThis.__OCCUMED_MAP__ = map;
  globalThis.__OCCUMED_MAP_V2__ = {
    ready: false,
    sourceId,
    sourceCount: Object.keys(style.sources).length,
    projection: 'mercator',
    architecture: 'clean-worldwide-vector-v2',
    errors
  };

  await waitForIdle(map);
  const renderedFeatures = map.queryRenderedFeatures();
  const sourceLoaded = map.isSourceLoaded(sourceId);
  const sourceLayers = new Set(renderedFeatures.map((feature) => feature.sourceLayer).filter(Boolean));
  const contract = globalThis.__OCCUMED_MAP_V2__;
  Object.assign(contract, {
    ready: true,
    sourceLoaded,
    renderedFeatureCount: renderedFeatures.length,
    renderedSourceLayers: [...sourceLayers].sort(),
    zoom: map.getZoom(),
    center: map.getCenter().toArray(),
    tilesLoaded: map.areTilesLoaded()
  });

  if (!sourceLoaded || renderedFeatures.length < 25 || sourceLayers.size < 3) {
    throw new Error('The replacement worldwide source loaded without enough visible map detail.');
  }

  setStatus('Occu-Med map ready', 'ready');
  document.documentElement.classList.add('map-is-ready');
  return map;
}
