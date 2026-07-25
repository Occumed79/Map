import { createOccumedMap } from './occumed-map.js';
import './styles.css';

async function initialize() {
  try {
    const map = await createOccumedMap({
      container: 'map',
      styleUrl: '/style.json'
    });

    map.on('error', (event) => {
      console.error('Occu-Med Mapbox resource error:', event?.error || event);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Occu-Med map startup failure:', message);
    document.body.dataset.mapError = message;
  }
}

initialize();
