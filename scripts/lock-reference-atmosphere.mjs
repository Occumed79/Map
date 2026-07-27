import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

runtime.projection = { type: 'globe' };

// MapLibre's atmosphere is a screen-space globe effect, not a directional sun.
// Keep the map surface neutral and confine the white-blue light to a thin,
// even rim at the globe limb. High blend values push the atmosphere far across
// the visible hemisphere and create the incorrect "sunlit half-planet" wash.
runtime.sky = {
  'sky-color': '#181A1D',
  'horizon-color': 'rgba(245, 253, 255, 0.98)',
  'fog-color': 'rgba(184, 230, 255, 0.14)',
  'sky-horizon-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0, 0.052,
    2.5, 0.042,
    4.5, 0.018,
    6.25, 0
  ],
  'horizon-fog-blend': 0.08,
  'fog-ground-blend': 0,
  'atmosphere-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0, 0.18,
    2.5, 0.145,
    4.5, 0.06,
    6.25, 0
  ]
};

delete runtime.fog;
delete runtime.light;

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:reference-atmosphere': true,
  'occumed:reference-atmosphere-pass': 3,
  'occumed:atmosphere-surface-wash-disabled': true,
  'occumed:atmosphere-edge-only': true,
  'occumed:atmosphere-fades-before-detail': true
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Locked a narrow, even white-blue globe rim without surface wash.');
