import { createOccumedMap } from './occumed-map.js';
import './styles.css';

const statusElement = document.querySelector('#map-status');
const errorPanel = document.querySelector('#map-error');
const errorMessage = document.querySelector('#map-error-message');

let mapReady = false;
let startupTimer = null;

function clearError() {
  errorMessage.textContent = '';
  errorPanel.hidden = true;
}

function markReady(message) {
  mapReady = true;
  if (startupTimer) {
    window.clearTimeout(startupTimer);
    startupTimer = null;
  }
  clearError();
  statusElement.textContent = message;
  document.documentElement.classList.add('map-is-ready');
}

function showFatalError(message) {
  document.documentElement.classList.remove('map-is-ready');
  statusElement.textContent = 'Map unavailable';
  errorMessage.textContent = message || 'The basemap failed before it finished loading.';
  errorPanel.hidden = false;
}

function errorDetails(event) {
  return {
    message: event?.error?.message || event?.message || '',
    sourceId: event?.sourceId || null,
    sourceDataType: event?.sourceDataType || null,
    dataType: event?.dataType || null,
    tile: event?.tile || null
  };
}

async function initialize() {
  try {
    const map = await createOccumedMap({
      container: 'map',
      styleUrl: import.meta.env.VITE_OCCUMED_STYLE_URL || '/style/occumed-open.json'
    });

    startupTimer = window.setTimeout(() => {
      if (!mapReady) {
        showFatalError('The basemap did not finish loading within 20 seconds.');
      }
    }, 20_000);

    map.once('load', () => {
      markReady('Basemap loaded');
    });

    map.once('idle', () => {
      markReady('Occu-Med map ready');
    });

    map.on('error', (event) => {
      // MapLibre emits this event for individual tile, glyph, terrain, and
      // source requests. Those warnings must never cover a map that rendered.
      console.warn('Occu-Med basemap resource warning:', errorDetails(event));
    });
  } catch (error) {
    if (startupTimer) window.clearTimeout(startupTimer);
    showFatalError(error instanceof Error ? error.message : String(error));
  }
}

initialize();
