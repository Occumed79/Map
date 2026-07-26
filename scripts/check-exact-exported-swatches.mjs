import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = JSON.parse(
  await fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8')
);

const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const color = (id, property) => layer(id)?.paint?.[property];

const EXACT = {
  land: '#E0E0D1',
  wood: '#83CC66CC',
  scrub: '#A3D48799',
  crop: '#D1DD8899',
  grass: '#B4DE9C99',
  snow: '#EDF3F8',
  fallback: '#A0D382',
  park: '#A5CC8E',
  pitch: '#A9DB70',
  wetland: '#A4CAD6',
  water: '#79BCEC',
  waterShadow: '#7293EE'
};

expect(color('land', 'background-color') === EXACT.land, 'The exact exported land swatch changed.');
expect(color('water', 'fill-color') === EXACT.water, 'The exact exported water blue changed.');
expect(color('waterway', 'line-color') === EXACT.water, 'The exact exported waterway blue changed.');
expect(color('water-shadow', 'fill-color') === EXACT.waterShadow, 'The exact exported water-shadow blue changed.');
expect(color('waterway-shadow', 'line-color') === EXACT.waterShadow, 'The exact exported waterway-shadow blue changed.');
expect(color('wetland', 'fill-color') === EXACT.wetland, 'The exact exported wetland blue changed.');
expect(color('wetland-pattern', 'fill-color') === EXACT.wetland, 'The exact exported wetland-pattern blue changed.');
expect(color('national-park', 'fill-color') === EXACT.park, 'The exact exported national-park green changed.');
expect(color('national-park_tint-band', 'line-color') === EXACT.park, 'The exact exported park tint-band green changed.');
expect(color('pitch-outline', 'line-color') === EXACT.pitch, 'The exact exported pitch green changed.');

const landcoverColors = JSON.stringify(color('landcover', 'fill-color') || []);
for (const [name, value] of Object.entries({
  wood: EXACT.wood,
  scrub: EXACT.scrub,
  crop: EXACT.crop,
  grass: EXACT.grass,
  snow: EXACT.snow,
  fallback: EXACT.fallback
})) {
  expect(landcoverColors.includes(value), `The exact exported landcover ${name} swatch changed.`);
}

expect(layer('landcover')?.minzoom === 0, 'Landcover no longer begins at globe zoom.');
expect(JSON.stringify(color('landcover', 'fill-opacity')) === JSON.stringify([
  'interpolate', ['linear'], ['zoom'], 0, 1, 11, 1, 12, 0
]), 'Landcover is being multiplied by a different zoom opacity.');
expect(color('landuse', 'fill-opacity') === 1, 'Detailed landuse colors are being weakened by an additional opacity.');
expect(color('water', 'fill-opacity') === 1, 'Water is not fully opaque.');

const relief = layer('occumed-shaded-relief');
expect(relief?.paint?.['raster-saturation'] === -1, 'The independent relief raster is recoloring the exported palette.');
expect(relief?.paint?.['raster-hue-rotate'] === 0, 'The independent relief raster is rotating exported hues.');
expect(relief?.maxzoom === 7, 'Pixel-based relief does not disappear before detailed zooms.');
const reliefOpacity = relief?.paint?.['raster-opacity'] || [];
const reliefOutputs = [];
for (let index = 4; index < reliefOpacity.length; index += 2) {
  if (typeof reliefOpacity[index] === 'number') reliefOutputs.push(reliefOpacity[index]);
}
expect(reliefOutputs.includes(0.12), 'The neutral relief texture curve changed.');
expect(reliefOutputs.every((value) => value >= 0 && value <= 0.12), 'The relief raster is opaque enough to distort the exported swatches.');
expect(reliefOutputs.at(-1) === 0, 'The relief raster does not fully disappear by its final zoom stop.');

const hillshade = layer('occumed-hillshade');
expect(hillshade?.paint?.['hillshade-shadow-color'] === '#0000004D', 'Hillshade shadow is tinting terrain instead of changing lightness only.');
expect(hillshade?.paint?.['hillshade-highlight-color'] === '#FFFFFF4D', 'Hillshade highlight is tinting terrain instead of changing lightness only.');
expect(hillshade?.paint?.['hillshade-accent-color'] === '#00000026', 'Hillshade accent is tinting terrain instead of changing lightness only.');

expect(runtime.metadata?.['occumed:reference-color-system'] === 'exact-exported-swatches-v9', 'The exact exported swatch pass did not run.');
expect(runtime.metadata?.['occumed:colored-relief-disabled'] === true, 'Colored relief protection is missing.');
expect(runtime.metadata?.['occumed:layer-specific-palette'] === true, 'Layer-specific palette protection is missing.');
expect(runtime.metadata?.['occumed:high-dpi-vector-clarity'] === true, 'High-DPI clarity protection is missing.');

if (failures.length) {
  console.error('Exact exported swatch validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Exact exported swatches guarded for land, landcover, parks, wetlands, water, and water shadows; raster hue drift and detailed-zoom blur disabled.');
