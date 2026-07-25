import { createOccumedMap } from './occumed-map.js';
import './styles.css';

const statusElement = document.querySelector('#map-status');
let mapReady = false;

function markReady(message) {
  if (mapReady) return;
  mapReady = true;
  statusElement.textContent = message;
  document.documentElement.classList.add('map-is-ready');
}

function markUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Occu-Med basemap startup failure:', message);
  statusElement.textContent = 'Map unavailable';
  document.documentElement.classList.remove('map-is-ready');
}

async function initialize() {
  try {
    const map = await createOccumedMap({
      container: 'map',
      styleUrl: import.meta.env.VITE_OCCUMED_STYLE_URL || '/style/occumed-open.json'
    });

    // A first rendered frame proves that the standalone viewer is functioning.
    // Individual tile, glyph, terrain, and source failures are diagnostics, not
    // reasons to cover an otherwise usable map with a fatal banner.
    map.once('render', () => markReady('Occu-Med map ready'));
    map.once('load', () => markReady('Occu-Med map ready'));
    map.once('idle', () => markReady('Occu-Med map ready'));

    map.on('error', (event) => {
      console.warn('Occu-Med basemap resource warning:', {
        message: event?.error?.message || event?.message || '',
        sourceId: event?.sourceId || null,
        sourceDataType: event?.sourceDataType || null,
        dataType: event?.dataType || null,
        tile: event?.tile || null
      });
    });
  } catch (error) {
    markUnavailable(error);
  }
}

initialize();
