import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REFERENCE_STUDIO_EXPRESSION_SWATCHES,
  REFERENCE_STUDIO_SWATCH_GROUPS,
  REFERENCE_STUDIO_UNAVAILABLE_SWATCHES
} from './reference-studio-swatches.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);

// Exact hex equivalents of the uploaded Studio swatches shown in style.json.
// These are not broad category guesses. Every named structure keeps its own color.
const EXACT = Object.freeze({
  ocean: '#79BCEC',
  land: '#E0E0D1',
  landcoverWood: '#83CC66CC',         // hsla(103, 50%, 60%, 0.8)
  landcoverScrub: '#A3D48799',        // hsla(98, 47%, 68%, 0.6)
  landcoverCrop: '#D1DD8899',         // hsla(68, 55%, 70%, 0.6)
  landcoverGrass: '#B4DE9C99',        // hsla(98, 50%, 74%, 0.6)
  landcoverSnow: '#EDF3F8',           // hsl(205, 45%, 95%)
  landcoverSand: '#E0E0D1',           // supplied Studio land chip
  landcoverFallback: '#A0D382',       // hsl(98, 48%, 67%)
  nationalPark: '#A5CC8E',            // hsl(98, 38%, 68%)
  pitchOutline: '#A9DB70',            // hsl(88, 60%, 65%)
  wetland: '#A5CAD6',                 // supplied Studio chip, converted from Display-P3
  water: '#79BCEC',                   // hsl(205, 75%, 70%)
  waterShadow: '#7293EE',             // hsl(224, 79%, 69%)
  // Preblended, opaque equivalents of the exported 35%-alpha bathymetry
  // swatches over the permanent ocean background. Opaque depth is idempotent:
  // nested bands cannot accumulate different alpha at tile boundaries.
  depthShallow: '#79BCEC',
  depthMid: '#6EB6EA',
  depthDeep: '#63B1E9'
});

function requireLayer(id) {
  const candidate = layer(id);
  if (!candidate) throw new Error(`Required exported layer is missing: ${id}`);
  candidate.paint ||= {};
  return candidate;
}

function enterBy(candidate, zoom) {
  candidate.minzoom = Math.min(candidate.minzoom ?? 24, zoom);
}

// The base and natural-structure colors are fixed to the exact exported swatches.
const ocean = requireLayer('land');
ocean.paint['background-color'] = EXACT.ocean;
ocean.paint['background-opacity'] = 1;

const land = requireLayer('occumed-land-surface');
land.paint['fill-color'] = EXACT.land;
land.paint['fill-opacity'] = 1;
land.paint['fill-antialias'] = true;

const landcover = requireLayer('landcover');
enterBy(landcover, 0);
landcover.maxzoom = 12;
landcover.filter = undefined;
landcover.paint['fill-color'] = [
  'match',
  [
    'match',
    ['get', 'class'],
    'farmland', 'crop',
    'ice', 'snow',
    ['get', 'class']
  ],
  'wood', EXACT.landcoverWood,
  'scrub', EXACT.landcoverScrub,
  'crop', EXACT.landcoverCrop,
  'grass', EXACT.landcoverGrass,
  'snow', EXACT.landcoverSnow,
  'sand', EXACT.landcoverSand,
  EXACT.landcoverFallback
];
landcover.paint['fill-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0, 1,
  11, 1,
  12, 0
];
landcover.paint['fill-antialias'] = false;

// OpenMapTiles continent values can contain multilingual aliases joined by
// semicolons. The supplied globe uses country and city labels instead, so the
// continent layer is intentionally suppressed at the limb.
const continentLabel = requireLayer('continent-label');
continentLabel.layout ||= {};
continentLabel.layout.visibility = 'none';

const countryLabel = requireLayer('country-label');
countryLabel.filter = [
  'all',
  ['==', ['get', 'class'], 'country'],
  [
    'step',
    ['zoom'],
    ['<=', ['coalesce', ['get', 'rank'], 99], 3],
    2.5,
    ['<=', ['coalesce', ['get', 'rank'], 99], 4],
    3.5,
    ['<=', ['coalesce', ['get', 'rank'], 99], 5],
    5,
    true
  ]
];
countryLabel.layout['text-field'] = [
  'coalesce',
  ['get', 'name:en'],
  ['get', 'name:latin'],
  ['get', 'name'],
  ''
];
countryLabel.layout['symbol-sort-key'] = ['coalesce', ['get', 'rank'], 99];

// Once detailed landuse takes over, do not multiply the exported color by another
// zoom opacity. The color literal itself already contains any intended alpha.
const landuse = requireLayer('landuse');
enterBy(landuse, 5);
landuse.paint['fill-opacity'] = 1;

const nationalPark = requireLayer('national-park');
enterBy(nationalPark, 5);
nationalPark.paint['fill-color'] = EXACT.nationalPark;
nationalPark.paint['fill-opacity'] = 1;

const nationalParkBand = requireLayer('national-park_tint-band');
enterBy(nationalParkBand, 5);
nationalParkBand.paint['line-color'] = EXACT.nationalPark;
nationalParkBand.paint['line-opacity'] = 1;

const pitchOutline = requireLayer('pitch-outline');
pitchOutline.paint['line-color'] = EXACT.pitchOutline;
pitchOutline.paint['line-opacity'] = 1;

for (const id of ['wetland', 'wetland-pattern']) {
  const candidate = requireLayer(id);
  enterBy(candidate, 5);
  candidate.paint['fill-color'] = EXACT.wetland;
  candidate.paint['fill-opacity'] = 1;
}

const water = requireLayer('water');
water.paint['fill-color'] = EXACT.water;
water.paint['fill-opacity'] = 1;

const waterDepth = requireLayer('water-depth');
delete waterDepth.maxzoom;
waterDepth.paint['fill-antialias'] = false;
waterDepth.paint['fill-color'] = [
  'interpolate',
  ['linear'],
  ['get', 'min_depth'],
  0, EXACT.depthShallow,
  200, EXACT.depthMid,
  7000, EXACT.depthDeep
];
waterDepth.paint['fill-opacity'] = 1;

const waterway = requireLayer('waterway');
waterway.paint['line-color'] = EXACT.water;
waterway.paint['line-opacity'] = 1;

const waterShadow = requireLayer('water-shadow');
waterShadow.paint['fill-color'] = EXACT.waterShadow;
waterShadow.paint['fill-opacity'] = 1;

const waterwayShadow = requireLayer('waterway-shadow');
waterwayShadow.paint['line-color'] = EXACT.waterShadow;
waterwayShadow.paint['line-opacity'] = 1;

// Lock every solid Studio chip without flattening the layers whose colors are
// intentionally data- or zoom-driven. The screenshots are the authority for
// these sRGB literals, including their one-byte color-management differences.
for (const group of REFERENCE_STUDIO_SWATCH_GROUPS) {
  for (const id of group.layers) {
    const candidate = requireLayer(id);
    candidate.paint[group.property] = group.color;
  }
}

for (const group of REFERENCE_STUDIO_EXPRESSION_SWATCHES) {
  for (const id of group.layers) {
    const candidate = requireLayer(id);
    const expression = JSON.stringify(candidate.paint[group.property] || []);
    if (!expression.includes(group.color)) {
      throw new Error(`The ${id} expression no longer contains its supplied Studio swatch ${group.color}.`);
    }
  }
}

if (runtime.layers.some((candidate) => candidate.type === 'hillshade')) {
  throw new Error('One-source runtime must not contain a hillshade layer.');
}

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:reference-color-system': 'continuous-world-v10',
  'occumed:reference-color-pass': 10,
  'occumed:live-visual-qa-pass': 10,
  'occumed:palette-format': 'fixed-hex-per-layer',
  'occumed:palette-source': 'supplied-mapbox-studio-screenshots-display-p3-to-srgb',
  'occumed:layer-specific-palette': true,
  'occumed:raster-relief-disabled': true,
  'occumed:external-terrain-disabled': true,
  'occumed:opaque-depth-palette': true,
  'occumed:high-dpi-vector-clarity': true,
  'occumed:exact-swatches': EXACT,
  'occumed:unavailable-reference-swatches': REFERENCE_STUDIO_UNAVAILABLE_SWATCHES
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Locked the supplied Studio swatches by layer and preserved expression-driven cartography.');
