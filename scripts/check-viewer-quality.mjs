import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [html, main, helper, fonts, runtime] = await Promise.all([
  fs.readFile(path.join(root, 'index.html'), 'utf8'),
  fs.readFile(path.join(root, 'src/main.js'), 'utf8'),
  fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/normalize-runtime-fonts.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8').then(JSON.parse)
]);

const failures = [];
const fail = (message) => failures.push(message);
const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);

if (html.includes('map-error') || html.includes('Map could not be displayed')) {
  fail('The standalone viewer still contains the obsolete fatal error overlay.');
}
if (main.includes('startupTimer') || main.includes('showFatalError')) {
  fail('The standalone viewer still contains timeout-based false fatal logic.');
}
if (!helper.includes('zoom = 1.82')) {
  fail('The standalone globe must start with the live-QA full-globe framing.');
}
if (!helper.includes('antialias: true')) {
  fail('The standalone globe must render with antialiasing enabled.');
}
if (fonts.includes("'DIN Pro Medium', 'Open Sans Semibold'")) {
  fail('DIN Pro Medium must not be replaced with an overly heavy open font.');
}

const relief = layer('occumed-shaded-relief');
if ((relief?.paint?.['raster-saturation'] ?? 0) < 0.9) {
  fail('The low-zoom terrain palette is still too desaturated.');
}
if ((relief?.paint?.['raster-contrast'] ?? 0) < 0.18) {
  fail('The low-zoom terrain palette lacks sufficient definition.');
}
if ((relief?.maxzoom ?? 0) < 9) {
  fail('Relief disappears before the regional reference zooms.');
}

const land = layer('land');
if (land?.paint?.['background-color'] !== 'hsl(68, 28%, 83%)') {
  fail('The viewer reverted to the washed-out beige land base.');
}

const water = layer('water');
const waterOpacity = JSON.stringify(water?.paint?.['fill-opacity'] || []);
if (!waterOpacity.includes('0.9')) {
  fail('Low-zoom water no longer reveals restrained bathymetry.');
}
if (water?.paint?.['fill-color'] !== 'hsl(205, 76%, 66%)') {
  fail('The viewer reverted to the pale cyan ocean.');
}

const motorwayFilter = JSON.stringify(layer('road-motorway-trunk')?.filter || []);
if (!motorwayFilter.includes('brunnel') || !motorwayFilter.includes('none')) {
  fail('Regional surface highways are still filtered out when brunnel is absent.');
}

const placeFilter = JSON.stringify(layer('settlement-major-label')?.filter || []);
if (!placeFilter.includes('rank')) {
  fail('The major-place label density hierarchy is missing.');
}
if (layer('state-label')?.paint?.['text-opacity'] !== 0.5) {
  fail('State labels are too visually dominant.');
}

if (!runtime.metadata?.['occumed:exported-cartography-restored']) {
  fail('The exported vector cartography was not restored after endpoint translation.');
}
if (runtime.metadata?.['occumed:reference-color-system'] !== 'mapbox-photo-reference-v4') {
  fail('The final screenshot-calibrated color pass did not run.');
}

if (failures.length) {
  console.error('Standalone viewer quality validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Viewer quality validated: clean chrome, full-globe framing, corrected reference colors, visible roads, ranked labels, and terrain.');
