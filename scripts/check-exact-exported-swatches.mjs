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
  ocean: '#4F9CD6',
  land: '#8FB86B',
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

expect(color('land', 'background-color') === EXACT.ocean, 'The permanent ocean background changed.');
expect(color('occumed-land-surface', 'fill-color') === EXACT.land, 'The saturated land surface changed.');
expect(color('water', 'fill-color') === EXACT.water, 'The inland-water blue changed.');
expect(color('waterway', 'line-color') === EXACT.water, 'The waterway blue changed.');
expect(color('water-shadow', 'fill-color') === EXACT.waterShadow, 'The water-shadow blue changed.');
expect(color('waterway-shadow', 'line-color') === EXACT.waterShadow, 'The waterway-shadow blue changed.');
expect(color('wetland', 'fill-color') === EXACT.wetland, 'The wetland blue changed.');
expect(color('wetland-pattern', 'fill-color') === EXACT.wetland, 'The wetland-pattern blue changed.');
expect(color('national-park', 'fill-color') === EXACT.park, 'The national-park green changed.');
expect(color('national-park_tint-band', 'line-color') === EXACT.park, 'The park tint-band green changed.');
expect(color('pitch-outline', 'line-color') === EXACT.pitch, 'The pitch green changed.');

const landcoverColors = JSON.stringify(color('landcover', 'fill-color') || []);
for (const [name, value] of Object.entries({
  wood: EXACT.wood,
  scrub: EXACT.scrub,
  crop: EXACT.crop,
  grass: EXACT.grass,
  snow: EXACT.snow,
  fallback: EXACT.fallback
})) {
  expect(landcoverColors.includes(value), `The landcover ${name} swatch changed.`);
}

expect(layer('landcover')?.minzoom === 0, 'Landcover no longer begins at globe zoom.');
expect(color('occumed-land-surface', 'fill-opacity') === 1, 'The worldwide land surface is translucent.');
expect(color('landuse', 'fill-opacity') === 1, 'Detailed landuse colors are weakened.');
expect(color('water', 'fill-opacity') === 1, 'Water is not fully opaque.');
expect(!runtime.layers.some((candidate) => candidate.type === 'raster'), 'A raster basemap was reintroduced.');

const hillshade = layer('occumed-hillshade');
expect(hillshade?.paint?.['hillshade-shadow-color'] === '#0000004D', 'Hillshade shadows are tinting terrain.');
expect(hillshade?.paint?.['hillshade-highlight-color'] === '#FFFFFF4D', 'Hillshade highlights are tinting terrain.');
expect(hillshade?.paint?.['hillshade-accent-color'] === '#00000026', 'Hillshade accents are tinting terrain.');

expect(runtime.metadata?.['occumed:reference-color-system'] === 'continuous-world-v10', 'The continuous-world color pass did not run.');
expect(runtime.metadata?.['occumed:raster-relief-disabled'] === true, 'Raster relief protection is missing.');
expect(runtime.metadata?.['occumed:layer-specific-palette'] === true, 'Layer-specific palette protection is missing.');
expect(runtime.metadata?.['occumed:high-dpi-vector-clarity'] === true, 'High-DPI clarity protection is missing.');

if (failures.length) {
  console.error('Continuous-world palette validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Continuous-world palette guarded: saturated green land, clear blue water, and no raster fallback.');
