import { createOccumedMap } from './occumed-map.js';
import './styles.css';

const statusElement = document.querySelector('#map-status');
const errorPanel = document.querySelector('#map-error');
const errorMessage = document.querySelector('#map-error-message');

function showError(message) {
  statusElement.textContent = 'Map unavailable';
  errorMessage.textContent = message;
  errorPanel.hidden = false;
}

async function initialize() {
  try {
    const map = await createOccumedMap({
      container: 'map',
      styleUrl: import.meta.env.VITE_OCCUMED_STYLE_URL || '/style/occumed-open.json'
    });

    map.once('load', () => {
      statusElement.textContent = 'Basemap loaded';
    });

    map.once('idle', () => {
      statusElement.textContent = 'Occu-Med map ready';
    });

    map.on('error', (event) => {
      const message = event?.error?.message;
      if (message) showError(message);
    });
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

initialize();
