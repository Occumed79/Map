import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

/*
 * MapLibre's sky model is experimental and does not behave like Mapbox fog.
 * A direct translation caused severe directional overexposure while rotating.
 * Use a restrained, orientation-neutral atmosphere that preserves a thin rim
 * without washing out the map surface.
 */
runtime.sky = {
  'sky-color': '#05080c',
  'horizon-color': 'rgba(238, 249, 255, 0.96)',
  'fog-color': 'rgba(170, 220, 245, 0.08)',
  'sky-horizon-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    0.025,
    3,
    0.02,
    5,
    0.01,
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
    0.12,
    3,
    0.1,
    5,
    0.04,
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
    0.5,
    2.5,
    0.44,
    4.5,
    0.24,
    6.5,
    0
  ],
  'raster-saturation': 0.32,
  'raster-contrast': 0.04,
  'raster-brightness-min': 0.06,
  'raster-brightness-max': 0.9,
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
    0.05,
    8,
    0.14,
    15,
    0.1
  ],
  'hillshade-shadow-color': 'hsla(215, 22%, 28%, 0.45)',
  'hillshade-highlight-color': 'hsla(48, 38%, 96%, 0.38)',
  'hillshade-accent-color': 'hsla(95, 22%, 48%, 0.28)',
  'hillshade-illumination-direction': 335,
  'hillshade-illumination-anchor': 'map'
};

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:mapbox-fog-translated-to-maplibre-sky': true,
  'occumed:globe-parity-pass': 2,
  'occumed:stable-orientation-neutral-atmosphere': true
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Applied stable Occu-Med globe atmosphere and restrained relief treatment.');
