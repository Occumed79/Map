import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = JSON.parse(
  await fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8')
);

const failures = [];
const fail = (message) => failures.push(message);
const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);

const requiredLayers = [
  'land',
  'landcover',
  'landuse',
  'water',
  'waterway',
  'building',
  'admin-0-boundary',
  'admin-1-boundary',
  'road-motorway-trunk',
  'road-primary',
  'road-secondary-tertiary',
  'road-street-low',
  'country-label',
  'state-label',
  'settlement-major-label',
  'settlement-minor-label',
  'settlement-subdivision-label'
];

for (const id of requiredLayers) {
  if (!layer(id)) fail(`Required regional/street layer is missing: ${id}`);
}

const landuseLayers = runtime.layers.filter(
  (candidate) => candidate.metadata?.['occumed:original-source-layer'] === 'landuse'
);
if (!landuseLayers.length) fail('No translated landuse layers remain.');
if (landuseLayers.some((candidate) => !candidate.metadata?.['occumed:open-class-normalized'])) {
  fail('One or more landuse layers bypass the open-schema class normalization.');
}

const overlayLayers = runtime.layers.filter(
  (candidate) => candidate.metadata?.['occumed:original-source-layer'] === 'landuse_overlay'
);
if (!overlayLayers.length) fail('No translated landuse-overlay layers remain.');
if (overlayLayers.some((candidate) => !candidate.metadata?.['occumed:open-class-normalized'])) {
  fail('One or more park/wetland layers bypass the open-schema class normalization.');
}

const expectedPlaceClasses = {
  'continent-label': 'continent',
  'country-label': 'country',
  'state-label': 'state',
  'settlement-major-label': 'city',
  'settlement-minor-label': 'village',
  'settlement-subdivision-label': 'suburb'
};

for (const [id, expectedClass] of Object.entries(expectedPlaceClasses)) {
  const candidate = layer(id);
  if (!candidate) continue;
  const filterText = JSON.stringify(candidate.filter || []);
  if (!candidate.metadata?.['occumed:open-place-filter']) {
    fail(`${id} is not using an explicit OpenMapTiles place filter.`);
  }
  if (!filterText.includes(expectedClass)) {
    fail(`${id} does not select the expected ${expectedClass} feature class.`);
  }
}

const water = layer('water');
const waterOpacity = water?.paint?.['fill-opacity'];
if (waterOpacity !== 1 && !Array.isArray(waterOpacity)) {
  fail('The water layer must use either full opacity or a controlled zoom opacity expression.');
}

const landcover = layer('landcover');
if (!Array.isArray(landcover?.paint?.['fill-opacity'])) {
  fail('The landcover layer must preserve the strong green low-zoom hierarchy.');
}

const roadLayers = runtime.layers.filter(
  (candidate) =>
    candidate.type === 'line' &&
    ['road', 'structure'].includes(candidate.metadata?.['occumed:original-source-layer'])
);
if (roadLayers.length < 20) {
  fail(`Too few translated road line layers remain for crisp road hierarchy: ${roadLayers.length}.`);
}
if (roadLayers.some((candidate) => candidate['source-layer'] !== 'transportation')) {
  fail('A translated road layer is not using the OpenMapTiles transportation source layer.');
}

const symbolLayers = runtime.layers.filter((candidate) => candidate.type === 'symbol');
if (symbolLayers.length < 30) fail(`Too few label layers remain: ${symbolLayers.length}.`);

const appSpecificTerms = [
  'provider',
  'clinic',
  'employer',
  'opportunity',
  'procurement',
  'injury',
  'applicant'
];
for (const candidate of runtime.layers) {
  const identity = `${candidate.id} ${candidate.source || ''}`.toLowerCase();
  if (appSpecificTerms.some((term) => identity.includes(term))) {
    fail(`Application-specific content leaked into the shared basemap: ${candidate.id}`);
  }
}

if (!runtime.metadata?.['occumed:open-schema-parity']) {
  fail('The runtime style is missing the open-schema parity marker.');
}

if (failures.length) {
  console.error('Occu-Med cartography parity validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Cartography parity validated: ${roadLayers.length} road layers, ${symbolLayers.length} symbol layers, normalized landuse, place hierarchy, and overlay isolation.`
);
