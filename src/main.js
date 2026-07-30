import { startOccumedMapV2 } from './new-map-v2.js';
import './new-map-v2.css';

const statusElement = document.querySelector('#map-status');

startOccumedMapV2().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Occu-Med map v2 startup failure:', message);
  if (statusElement) statusElement.textContent = 'Map unavailable';
  document.documentElement.dataset.mapState = 'error';
  document.documentElement.classList.remove('map-is-ready');
});
