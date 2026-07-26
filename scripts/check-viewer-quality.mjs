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
if (relief?.paint?.['raster-saturation'] !== -1) {
  fail('The colored hypsometric raster is not fully neutralized.');
}
if ((relief?.paint?.['raster-contrast'] ?? 1) > 0.08) {
  fail('Neutral relief contrast is high enough to distort the screenshot palette.');
}
if ((relief?.maxzoom ?? 99) > 8) {
  fail('Raster relief persists too far into regional and city zooms.');
}
const reliefOpacity = JSON.stringify(relief?.paint?.['raster-opacity'] || []);
if (reliefOpacity.includes('0.72') || reliefOpacity.includes('0.64')) {
  fail('The previous fluorescent relief opacity has returned.');
}

const land = layer('land');
if (land?.paint?.['background-color'] !== '#D8DCB9') {
  fail('The screenshot land hex changed.');
}

const water = layer('water');
const waterOpacity = JSON.stringify(water?.paint?.['fill-opacity'] || []);
if (!waterOpacity.includes('0.92')) {
  fail('The restrained low-zoom water blend changed.');
}
if (water?.paint?.['fill-color'] !== '#70AFE0') {
  fail('The screenshot ocean hex changed.');
}

if (layer('road-motorway-trunk')?.paint?.['line-color'] !== '#F48773') {
  fail('The screenshot coral highway hex changed.');
}
if (layer('admin-0-boundary')?.paint?.['line-color'] !== '#BF858E') {
  fail('The screenshot country-border hex changed.');
}

const motorwayFilter = JSON.stringify(layer('road-motorway-trunk')?.filter || []);
if (!motorwayFilter.includes('brunnel') || !motorwayFilter.includes('none')) {
  fail('Regional surface highways are still filtered out when brunnel is absent.');
}

const placeFilter = JSON.stringify(layer('settlement-major-label')?.filter || []);
if (!placeFilter.includes('rank')) {
  fail('The major-place label density hierarchy is missing.');
}
if (layer('settlement-major-label')?.paint?.['text-color'] !== '#303840') {
  fail('The screenshot dark-slate place-label hex changed.');
}
if (layer('state-label')?.paint?.['text-opacity'] !== 0.5) {
  fail('State labels are too visually dominant.');
}

if (!runtime.metadata?.['occumed:exported-cartography-restored']) {
  fail('The exported vector cartography was not restored after endpoint translation.');
}
if (runtime.metadata?.['occumed:reference-color-system'] !== 'mapbox-screenshot-hex-v5') {
  fail('The final screenshot hex color pass did not run.');
}
if (runtime.metadata?.['occumed:palette-format'] !== 'fixed-hex') {
  fail('The fixed-hex palette marker is missing.');
}

if (failures.length) {
  console.error('Standalone viewer quality validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Viewer quality validated: clean chrome, screenshot hex palette, neutral relief, coral roads, muted borders, ranked labels, and terrain.');
