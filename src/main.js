import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './styles.css';

const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim();
const statusElement = document.querySelector('#map-status');
const errorPanel = document.querySelector('#map-error');
const errorMessage = document.querySelector('#map-error-message');

function showError(message) {
  statusElement.textContent = 'Reference unavailable';
  errorMessage.textContent = message;
  errorPanel.hidden = false;
}

async function loadUntouchedStyle() {
  const response = await fetch('/style.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Unable to load the exported style (${response.status}).`);
  }
  return response.json();
}

async function initializeReferenceMap() {
  if (!token) {
    showError('VITE_MAPBOX_ACCESS_TOKEN is required only for this exact visual-reference renderer.');
    return;
  }

  try {
    mapboxgl.accessToken = token;
    const style = await loadUntouchedStyle();

    const map = new mapboxgl.Map({
      container: 'map',
      style,
      center: style.center,
      zoom: style.zoom,
      bearing: style.bearing ?? 0,
      pitch: style.pitch ?? 0,
      hash: true,
      antialias: true,
      attributionControl: true,
      preserveDrawingBuffer: true
    });

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

    map.once('load', () => {
      statusElement.textContent = `${style.layers.length} original layers loaded`;
      document.documentElement.dataset.mapReady = 'true';
    });

    map.on('error', (event) => {
      const message = event?.error?.message;
      if (message) showError(message);
    });
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

initializeReferenceMap();
