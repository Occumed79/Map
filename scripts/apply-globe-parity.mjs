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

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:mapbox-fog-translated-to-maplibre-sky': true,
  'occumed:globe-parity-pass': 3,
  'occumed:stable-orientation-neutral-atmosphere': true,
  'occumed:external-terrain-disabled': true,
  'occumed:visual-quality-pass': true
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Applied the refined Occu-Med globe rim without an external terrain source.');
