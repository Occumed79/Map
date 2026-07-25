import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const styleUrl = import.meta.env.VITE_STYLE_URL || '/style/style.json';
const rawTilesUrl = import.meta.env.VITE_PMTILES_URL || '/data/occumed.pmtiles';
const tilesUrl = rawTilesUrl.replace(/^pmtiles:\/\//, '');
const glyphsUrl =
  import.meta.env.VITE_GLYPHS_URL ||
  'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const spriteUrl =
  import.meta.env.VITE_SPRITE_URL ||
  'https://protomaps.github.io/basemaps-assets/sprites/v4/light';

const statusElement = document.querySelector('#map-status');
const errorPanel = document.querySelector('#map-error');
const errorMessage = document.querySelector('#map-error-message');

function showError(message) {
  statusElement.textContent = 'Data unavailable';
  errorMessage.textContent = message;
  errorPanel.hidden = false;
}

function resolveRuntimeAssets(style) {
  const resolved = structuredClone(style);

  for (const source of Object.values(resolved.sources || {})) {
    if (source?.url === 'pmtiles://__PMTILES_URL__') {
      source.url = `pmtiles://${tilesUrl}`;
    }
  }

  if (resolved.glyphs === '__GLYPHS_URL__') {
    resolved.glyphs = glyphsUrl;
  }

  if (resolved.sprite === '__SPRITE_URL__') {
    resolved.sprite = spriteUrl;
  }

  return resolved;
}

async function loadStyle() {
  const response = await fetch(styleUrl, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Unable to load ${styleUrl} (${response.status}).`);
  }

  return resolveRuntimeAssets(await response.json());
}

async function initializeMap() {
  try {
    const style = await loadStyle();

    const map = new maplibregl.Map({
      container: 'map',
      style,
      center: [-98.5, 39.5],
      zoom: 3.3,
      minZoom: 1,
      maxZoom: 18,
      attributionControl: true,
      hash: true
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

    map.on('load', () => {
      statusElement.textContent = 'Occu-Med map ready';
    });

    map.on('error', (event) => {
      const message = event?.error?.message || 'The vector-tile archive could not be loaded.';
      showError(message);
    });
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

initializeMap();
