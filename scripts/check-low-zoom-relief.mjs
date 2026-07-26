import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = JSON.parse(
  await fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8')
);

const relief = runtime.layers.find((candidate) => candidate.id === 'occumed-shaded-relief');
if (!relief) throw new Error('The open shaded-relief layer is missing.');

const expectedOpacity = JSON.stringify([
  'interpolate',
  ['linear'],
  ['zoom'],
  0, 0.48,
  2.5, 0.44,
  4.5, 0.38,
  6.5, 0.32,
  8.5, 0
]);
const actualOpacity = JSON.stringify(relief.paint?.['raster-opacity']);

if (actualOpacity !== expectedOpacity) {
  throw new Error('Regional physical-landscape opacity faded back to the washed-out beige configuration.');
}
if (relief.paint?.['raster-saturation'] !== 0.12) {
  throw new Error('Regional landscape saturation changed from the restrained approved value.');
}
if (relief.paint?.['raster-contrast'] !== 0.09) {
  throw new Error('Regional landscape contrast changed from the restrained approved value.');
}
if (relief.maxzoom !== 8.5) {
  throw new Error('The physical landscape must remain available through regional zooms and fade before city detail.');
}
if (runtime.metadata?.['occumed:low-zoom-landscape-pass'] !== 8) {
  throw new Error('The low-zoom landscape visibility pass did not run.');
}
if (runtime.metadata?.['occumed:regional-relief-visible'] !== true) {
  throw new Error('Regional landscape visibility protection is missing.');
}

console.log('Low-zoom landscape validated: restrained color remains visible from globe through regional zooms.');
