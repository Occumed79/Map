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

if (html.includes('map-error') || html.includes('Map could not be displayed')) {
  fail('The standalone viewer still contains the obsolete fatal error overlay.');
}
if (main.includes('startupTimer') || main.includes('showFatalError')) {
  fail('The standalone viewer still contains timeout-based false fatal logic.');
}
if (!helper.includes('zoom = 2.05')) {
  fail('The standalone globe must start at the approved full-world framing.');
}
if (fonts.includes("'DIN Pro Medium', 'Open Sans Semibold'")) {
  fail('DIN Pro Medium must not be replaced with an overly heavy open font.');
}

const relief = runtime.layers.find((layer) => layer.id === 'occumed-shaded-relief');
if ((relief?.paint?.['raster-saturation'] ?? 0) < 0.55) {
  fail('The low-zoom terrain palette is too desaturated.');
}
if ((relief?.paint?.['raster-contrast'] ?? 0) < 0.1) {
  fail('The low-zoom terrain palette lacks sufficient definition.');
}

if (failures.length) {
  console.error('Standalone viewer quality validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Viewer quality validated: clean chrome, full-world framing, lighter labels, and vivid terrain.');
