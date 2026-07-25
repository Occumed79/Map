import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

/*
 * MapLibre's sky model is experimental and does not behave like Mapbox fog.
 * Keep the surface orientation-neutral while restoring a visible white-blue
 * rim around the globe. Ground and horizon fog remain disabled so rotation
 * cannot wash out the map surface.
 */
runtime.sky = {
  'sky-color': '#05080c',
  'horizon-color': 'rgba(246, 252, 255, 0.99)',
  'fog-color': 'rgba(168, 218, 244, 0.06)',
  'sky-horizon-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    0.055,
    3,
    0.045,
    5,
    0.02,
    6,
    0
  ],
  'horizon-fog-blend': 0,
  'fog-ground-blend': 0,
  'atmosphere-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    0.18,
    3,
    0.15,
    5,
    0.07,
    6,
    0
  ]
};

delete runtime.fog;
delete runtime.light;

const relief = runtime.layers.find((layer) => layer.id === 'occumed-shaded-relief');
if (!relief) throw new Error('The generated low-zoom relief layer is missing.');

relief.paint = {
  'raster-opacity': [
    'interpolate',
    ['exponential', 1.2],
    ['zoom'],
    0,
    0.68,
    2.5,
    0.62,
    4.5,
    0.38,
    6.5,
    0
  ],
  'raster-saturation': 0.62,
  'raster-contrast': 0.12,
  'raster-brightness-min': 0.02,
  'raster-brightness-max': 0.94,
  'raster-resampling': 'linear',
  'raster-fade-duration': 0
};
relief.metadata = {
  ...(relief.metadata || {}),
  'occumed:purpose': 'low-zoom landcover and bathymetry texture',
  'occumed:visual-reference': 'exported Occu-Med Terrain globe',
  'occumed:orientation-neutral': true
};

const hillshade = runtime.layers.find((layer) => layer.id === 'occumed-hillshade');
if (!hillshade) throw new Error('The generated open hillshade layer is missing.');

hillshade.paint = {
  'hillshade-exaggeration': [
    'interpolate',
    ['linear'],
    ['zoom'],
    2,
    0.04,
    8,
    0.16,
    15,
    0.11
  ],
  'hillshade-shadow-color': 'hsla(215, 22%, 28%, 0.42)',
  'hillshade-highlight-color': 'hsla(48, 38%, 96%, 0.34)',
  'hillshade-accent-color': 'hsla(95, 26%, 46%, 0.32)',
  'hillshade-illumination-direction': 335,
  'hillshade-illumination-anchor': 'map'
};

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:mapbox-fog-translated-to-maplibre-sky': true,
  'occumed:globe-parity-pass': 3,
  'occumed:stable-orientation-neutral-atmosphere': true,
  'occumed:visual-quality-pass': true
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Applied refined Occu-Med globe rim, vivid low-zoom relief, and stable hillshade.');
