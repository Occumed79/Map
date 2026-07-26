import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const relief = runtime.layers.find((candidate) => candidate.id === 'occumed-shaded-relief');
if (!relief) throw new Error('The open shaded-relief layer is missing.');

// The exported vector structures already retain their own exact colors. This pass
// changes only the independent physical-landscape raster so regional views do not
// collapse into a beige base before the user reaches city zoom.
relief.maxzoom = 8.5;
relief.paint ||= {};
relief.paint['raster-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0, 0.48,
  2.5, 0.44,
  4.5, 0.38,
  6.5, 0.32,
  8.5, 0
];

// Keep the restrained color treatment from the approved structure-color pass.
// The higher visibility comes from opacity persistence, not fluorescent saturation.
relief.paint['raster-saturation'] = 0.12;
relief.paint['raster-contrast'] = 0.09;
relief.paint['raster-hue-rotate'] = -6;
relief.paint['raster-brightness-min'] = 0.08;
relief.paint['raster-brightness-max'] = 0.96;
relief.paint['raster-resampling'] = 'linear';
relief.paint['raster-fade-duration'] = 0;

relief.metadata = {
  ...(relief.metadata || {}),
  'occumed:purpose': 'visible colored physical landscape through globe and regional zooms',
  'occumed:low-zoom-landscape-pass': 8
};

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:low-zoom-landscape-pass': 8,
  'occumed:regional-relief-visible': true
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Strengthened restrained colored relief through regional zooms without recoloring vector structures.');
