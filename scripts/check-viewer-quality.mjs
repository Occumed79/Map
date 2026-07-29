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

function collectHex(value, colors = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) collectHex(child, colors);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectHex(child, colors);
  } else if (typeof value === 'string' && /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/.test(value)) {
    colors.add(value);
  }
  return colors;
}

if (html.includes('map-error') || html.includes('Map could not be displayed')) fail('The standalone viewer still contains the obsolete fatal error overlay.');
if (main.includes('startupTimer') || main.includes('showFatalError')) fail('The standalone viewer still contains timeout-based false fatal logic.');
if (!helper.includes('zoom = 2.43')) fail('The standalone globe must start with the supplied full-globe framing.');
if (!helper.includes('antialias: true')) fail('The standalone globe must render with antialiasing enabled.');
if (fonts.includes("'DIN Pro Medium', 'Open Sans Semibold'")) fail('DIN Pro Medium must not be replaced with an overly heavy open font.');

if (layer('land')?.paint?.['background-color'] !== '#79BCEC') fail('The supplied Studio ocean blue changed.');
if (layer('occumed-land-surface')?.paint?.['fill-color'] !== '#E0E0D1') fail('The supplied Studio land base changed.');
if (layer('water')?.paint?.['fill-color'] !== '#79BCEC') fail('The exact exported water blue changed.');
if (layer('water-shadow')?.paint?.['fill-color'] !== '#7293EE') fail('The exact exported water-shadow blue changed.');
if (layer('wetland')?.paint?.['fill-color'] !== '#A5CAD6') fail('The supplied Studio wetland blue changed.');
if (layer('national-park')?.paint?.['fill-color'] !== '#A5CC8E') fail('The exact exported park green changed.');

const landcover = layer('landcover');
const landcoverColors = JSON.stringify(landcover?.paint?.['fill-color'] || []);
for (const required of ['#83CC66CC', '#A3D48799', '#D1DD8899', '#B4DE9C99', '#EDF3F8', '#E0E0D1', '#A0D382']) {
  if (!landcoverColors.includes(required)) fail(`The exact exported landcover swatch ${required} is missing.`);
}
if ((landcover?.minzoom ?? 99) !== 0) fail('Landcover is unavailable at globe zoom.');
if (layer('continent-label')?.layout?.visibility !== 'none') fail('Noisy continent aliases are visible at the globe limb.');
if (!JSON.stringify(landcover?.paint?.['fill-opacity'] || []).includes('1')) fail('Landcover swatches are being weakened by zoom opacity.');
if (layer('landuse')?.paint?.['fill-opacity'] !== 1) fail('Detailed landuse swatches are being weakened by extra opacity.');
if (layer('water')?.paint?.['fill-opacity'] !== 1) fail('Water is translucent and will wash into the land background.');

if (runtime.layers.some((candidate) => candidate.type === 'raster')) fail('A raster fallback basemap was reintroduced.');

if (runtime.layers.some((candidate) => candidate.type === 'hillshade')) fail('An external hillshade layer was reintroduced.');
if (Object.keys(runtime.sources || {}).length !== 1) fail('Viewer no longer uses exactly one browser source.');

const allColors = collectHex(runtime.layers.map((candidate) => candidate.paint || {}));
if (allColors.size < 25) fail(`The exported per-structure palette was flattened to only ${allColors.size} colors.`);

const roadStructureLayers = runtime.layers.filter(
  (candidate) => candidate.type === 'line' && ['road', 'structure'].includes(candidate.metadata?.['occumed:original-source-layer'])
);
const roadStructureColors = collectHex(roadStructureLayers.map((candidate) => candidate.paint || {}));
if (roadStructureColors.size < 6) fail(`Road, tunnel, and bridge colors were flattened to ${roadStructureColors.size} values.`);

if ((layer('road-motorway-trunk')?.minzoom ?? 99) > 2) fail('Regional major roads enter too late.');
if ((layer('road-primary')?.minzoom ?? 99) > 3.75) fail('Regional primary roads enter too late.');
if ((layer('road-secondary-tertiary')?.minzoom ?? 99) > 5) fail('Regional secondary roads enter too late.');

const motorwayFilter = JSON.stringify(layer('road-motorway-trunk')?.filter || []);
if (!motorwayFilter.includes('brunnel') || !motorwayFilter.includes('none')) fail('Regional surface highways are still filtered out when brunnel is absent.');

const placeFilter = JSON.stringify(layer('settlement-major-label')?.filter || []);
if (!placeFilter.includes('rank')) fail('The major-place label density hierarchy is missing.');
if (layer('state-label')?.paint?.['text-opacity'] !== 0.5) fail('State labels are too visually dominant.');

if (layer('admin-0-boundary')?.paint?.['line-opacity'] !== 0.82) fail('Country boundaries are too faint for regional views.');
if (layer('admin-1-boundary')?.paint?.['line-opacity'] !== 0.58) fail('State boundaries are too faint for regional views.');

if (!runtime.metadata?.['occumed:exported-cartography-restored']) fail('The exported vector cartography was not restored after endpoint translation.');
if (runtime.metadata?.['occumed:reference-color-system'] !== 'continuous-world-v10') fail('The continuous-world color pass did not run.');
if (runtime.metadata?.['occumed:palette-format'] !== 'fixed-hex-per-layer') fail('The per-layer fixed-hex palette marker is missing.');
if (runtime.metadata?.['occumed:layer-specific-palette'] !== true) fail('Layer-specific palette protection is missing.');
if (runtime.metadata?.['occumed:raster-relief-disabled'] !== true) fail('Raster relief protection is missing.');

if (failures.length) {
  console.error('Standalone viewer quality validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Viewer guard passed: clean chrome, supplied Studio land and water, early hierarchy, and ${allColors.size} structure-specific colors.`);
