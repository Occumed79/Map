import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

runtime.projection = { type: 'globe' };

// Match the supplied Studio globe: dark space, a narrow white horizon edge,
// and a broader cool-blue atmospheric bloom. Ground and horizon fog remain
// disabled so the glow stays outside the globe instead of washing out the map.
runtime.sky = {
  'sky-color': '#03070B',
  'horizon-color': '#F5FDFF',
  'fog-color': '#B8E6FF',
  'sky-horizon-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0, 0.24,
    2.5, 0.2,
    4.5, 0.1,
    6.25, 0
  ],
  'horizon-fog-blend': 0,
  'fog-ground-blend': 0,
  'atmosphere-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0, 0.72,
    2.5, 0.65,
    4.5, 0.34,
    6.25, 0
  ]
};

delete runtime.fog;
delete runtime.light;

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:reference-atmosphere': true,
  'occumed:reference-atmosphere-pass': 1,
  'occumed:atmosphere-surface-wash-disabled': true,
  'occumed:atmosphere-fades-before-detail': true
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Locked the luminous white-blue reference atmosphere without adding surface fog.');
