import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);

// Exact hex equivalents of the uploaded Studio swatches shown in style.json.
// These are not broad category guesses. Every named structure keeps its own color.
const EXACT = Object.freeze({
  land: '#E0E0D1',                    // hsl(60, 20%, 85%)
  landcoverWood: '#83CC66CC',         // hsla(103, 50%, 60%, 0.8)
  landcoverScrub: '#A3D48799',        // hsla(98, 47%, 68%, 0.6)
  landcoverCrop: '#D1DD8899',         // hsla(68, 55%, 70%, 0.6)
  landcoverGrass: '#B4DE9C99',        // hsla(98, 50%, 74%, 0.6)
  landcoverSnow: '#EDF3F8',           // hsl(205, 45%, 95%)
  landcoverFallback: '#A0D382',       // hsl(98, 48%, 67%)
  nationalPark: '#A5CC8E',            // hsl(98, 38%, 68%)
  pitchOutline: '#A9DB70',            // hsl(88, 60%, 65%)
  wetland: '#A4CAD6',                 // hsl(194, 38%, 74%)
  water: '#79BCEC',                   // hsl(205, 75%, 70%)
  waterShadow: '#7293EE'              // hsl(224, 79%, 69%)
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
const land = requireLayer('land');
land.paint['background-color'] = EXACT.land;
land.paint['background-opacity'] = 1;

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

const waterway = requireLayer('waterway');
waterway.paint['line-color'] = EXACT.water;
waterway.paint['line-opacity'] = 1;

const waterShadow = requireLayer('water-shadow');
waterShadow.paint['fill-color'] = EXACT.waterShadow;
waterShadow.paint['fill-opacity'] = 1;

const waterwayShadow = requireLayer('waterway-shadow');
waterwayShadow.paint['line-color'] = EXACT.waterShadow;
waterwayShadow.paint['line-opacity'] = 1;

// The independent Natural Earth raster was the source of the yellow/fluorescent
// and later washed-out color drift. Keep only faint grayscale physical texture at
// globe zoom, then remove it before regional/city detail so vector edges stay crisp.
const relief = requireLayer('occumed-shaded-relief');
relief.maxzoom = 7;
relief.paint = {
  'raster-opacity': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0, 0.12,
    2.5, 0.09,
    4.5, 0.05,
    6, 0.02,
    7, 0
  ],
  'raster-saturation': -1,
  'raster-contrast': 0.04,
  'raster-hue-rotate': 0,
  'raster-brightness-min': 0.2,
  'raster-brightness-max': 0.95,
  'raster-resampling': 'linear',
  'raster-fade-duration': 0
};
relief.metadata = {
  ...(relief.metadata || {}),
  'occumed:purpose': 'neutral globe texture that fades before regional vector detail',
  'occumed:exact-swatches-pass': 9
};

// Use neutral light and shadow only. Terrain may change lightness, but never hue.
const hillshade = requireLayer('occumed-hillshade');
hillshade.minzoom = 1.5;
hillshade.maxzoom = 16;
hillshade.paint = {
  'hillshade-exaggeration': [
    'interpolate',
    ['linear'],
    ['zoom'],
    1.5, 0.04,
    5, 0.09,
    8, 0.15,
    11, 0.2,
    14, 0.24,
    16, 0.16
  ],
  'hillshade-shadow-color': '#0000004D',
  'hillshade-highlight-color': '#FFFFFF4D',
  'hillshade-accent-color': '#00000026',
  'hillshade-illumination-direction': 335,
  'hillshade-illumination-anchor': 'map'
};

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:reference-color-system': 'exact-exported-swatches-v9',
  'occumed:reference-color-pass': 9,
  'occumed:live-visual-qa-pass': 9,
  'occumed:palette-format': 'fixed-hex-per-layer',
  'occumed:layer-specific-palette': true,
  'occumed:colored-relief-disabled': true,
  'occumed:high-dpi-vector-clarity': true,
  'occumed:exact-swatches': EXACT
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Locked exact exported swatches, preserved vector detail, and faded pixel-based relief before regional zooms.');
