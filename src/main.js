import { createOccumedMap } from './occumed-map.js';
import './styles.css';

const statusElement = document.querySelector('#map-status');
const errorPanel = document.querySelector('#map-error');
const errorMessage = document.querySelector('#map-error-message');

let mapReady = false;

function clearError() {
  errorMessage.textContent = '';
  errorPanel.hidden = true;
}

function showFatalError(message) {
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

function isRecoverableResourceError(event) {
  return Boolean(
    mapReady ||
      event?.tile ||
      event?.sourceId ||
      event?.dataType === 'source' ||
      event?.sourceDataType
  );
}

async function initialize() {
  try {
    const map = await createOccumedMap({
      container: 'map',
      styleUrl: import.meta.env.VITE_OCCUMED_STYLE_URL || '/style/occumed-open.json'
    });

    map.once('load', () => {
      mapReady = true;
      clearError();
      statusElement.textContent = 'Basemap loaded';
    });

    map.once('idle', () => {
      mapReady = true;
      clearError();
      statusElement.textContent = 'Occu-Med map ready';
    });

    map.on('error', (event) => {
      const details = errorDetails(event);

      if (isRecoverableResourceError(event)) {
        console.warn('Occu-Med basemap resource warning:', details);
        return;
      }

      console.error('Occu-Med basemap startup failure:', details);
      showFatalError(details.message);
    });
  } catch (error) {
    showFatalError(error instanceof Error ? error.message : String(error));
  }
}

initialize();
