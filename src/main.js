import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const styleUrl = import.meta.env.VITE_STYLE_URL || '/style/style.json';
const rawTilesUrl = import.meta.env.VITE_PMTILES_URL || '/data/occumed.pmtiles';
const tilesUrl = rawTilesUrl.replace(/^pmtiles:\/\//, '');

const statusElement = document.querySelector('#map-status');
const errorPanel = document.querySelector('#map-error');
const errorMessage = document.querySelector('#map-error-message');

function showError(message) {
  statusElement.textContent = 'Data unavailable';
  errorMessage.textContent = message;
  errorPanel.hidden = false;
}

async function loadStyle() {
  const response = await fetch(styleUrl, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Unable to load ${styleUrl} (${response.status}).`);
  }

  const style = await response.json();

  for (const source of Object.values(style.sources || {})) {
    if (source?.url === 'pmtiles://__PMTILES_URL__') {
      source.url = `pmtiles://${tilesUrl}`;
    }
  }

  return style;
}

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
