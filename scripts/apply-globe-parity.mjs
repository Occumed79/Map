import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const exportedFog = runtime.fog || {};

runtime.sky = {
  'sky-color': exportedFog['space-color'] || 'hsl(205, 10%, 10%)',
  'horizon-color': exportedFog.color || 'hsl(200, 100%, 100%)',
  'fog-color': exportedFog['high-color'] || 'hsl(200, 100%, 60%)',
  'sky-horizon-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    0.12,
    4,
    0.08,
    6,
    0.18,
    8,
    0
  ],
  'horizon-fog-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    0.18,
    4,
    0.24,
    6,
    0.5,
    8,
    0
  ],
  'fog-ground-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    0,
    5,
    0.08,
    8,
    0
  ],
  'atmosphere-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    1,
    5,
    1,
    7,
    0
  ]
};

delete runtime.fog;

runtime.light = {
  anchor: 'map',
  position: [1.5, 90, 80],
  color: '#ffffff',
  intensity: 0.35
};

const relief = runtime.layers.find((layer) => layer.id === 'occumed-shaded-relief');
if (!relief) throw new Error('The generated low-zoom relief layer is missing.');

relief.paint = {
  'raster-opacity': [
    'interpolate',
    ['exponential', 1.25],
    ['zoom'],
    0,
    0.72,
    2.5,
    0.66,
    4.5,
    0.42,
    6.5,
    0
  ],
  'raster-saturation': 0.42,
  'raster-contrast': 0.08,
  'raster-brightness-min': 0.08,
  'raster-brightness-max': 0.96,
  'raster-resampling': 'linear',
  'raster-fade-duration': 0
};
relief.metadata = {
  ...(relief.metadata || {}),
  'occumed:purpose': 'low-zoom landcover and bathymetry texture',
  'occumed:visual-reference': 'exported Occu-Med Terrain globe'
};

const hillshade = runtime.layers.find((layer) => layer.id === 'occumed-hillshade');
if (!hillshade) throw new Error('The generated open hillshade layer is missing.');

hillshade.paint = {
  'hillshade-exaggeration': [
    'interpolate',
    ['linear'],
    ['zoom'],
    2,
    0.08,
    8,
    0.18,
    15,
    0.12
  ],
  'hillshade-shadow-color': 'hsla(215, 22%, 28%, 0.55)',
  'hillshade-highlight-color': 'hsla(48, 40%, 96%, 0.55)',
  'hillshade-accent-color': 'hsla(95, 22%, 48%, 0.35)',
  'hillshade-illumination-direction': 335,
  'hillshade-illumination-anchor': 'map'
};

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:mapbox-fog-translated-to-maplibre-sky': true,
  'occumed:globe-parity-pass': 1
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Applied Occu-Med globe atmosphere and low-zoom parity treatment.');
