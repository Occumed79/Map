import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);

// Fixed screenshot-reference palette. These are deliberately hex values rather
// than saturation/hue guesses so the final runtime cannot drift into neon color.
const HEX = Object.freeze({
  space: '#03070B',
  land: '#D8DCB9',
  forest: '#91CC78',
  scrub: '#AAD28C',
  farmland: '#D4D9A9',
  grass: '#B8D998',
  desert: '#E5E1CF',
  snow: '#F3F7F8',
  park: '#8FCC76',
  wetland: '#9CCFC1',
  water: '#70AFE0',
  waterway: '#50A3D8',
  waterwayShadow: '#6F97D3',
  borderCountry: '#BF858E',
  borderState: '#CB969C',
  motorway: '#F48773',
  primaryRoad: '#F29A74',
  secondaryRoad: '#EAAF79',
  localRoad: '#FAF9F4',
  path: '#E9CFA5',
  urban: '#E4E4DD',
  industrial: '#D7D8DE',
  airport: '#BFC8E6',
  label: '#303840',
  mutedLabel: '#68727A',
  waterLabel: '#D7EDF7',
  halo: '#F8F7F0',
  hillshadeShadow: '#52685B',
  hillshadeHighlight: '#FFF8E8',
  hillshadeAccent: '#6E8D69'
});

const land = layer('land');
if (!land) throw new Error('The exported land background layer is missing.');
land.paint ||= {};
land.paint['background-color'] = HEX.land;
land.paint['background-opacity'] = 1;

// Natural Earth shaded relief is used only for subtle physical texture. Its
// original hypsometric green/yellow color is fully desaturated before blending.
const relief = layer('occumed-shaded-relief');
if (!relief) throw new Error('The open shaded-relief layer is missing.');
relief.maxzoom = 8;
relief.paint = {
  'raster-opacity': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0, 0.2,
    2.5, 0.16,
    4.5, 0.11,
    6.5, 0.05,
    8, 0
  ],
  'raster-saturation': -1,
  'raster-contrast': 0.06,
  'raster-hue-rotate': 0,
  'raster-brightness-min': 0.18,
  'raster-brightness-max': 0.92,
  'raster-resampling': 'linear',
  'raster-fade-duration': 0
};
relief.metadata = {
  ...(relief.metadata || {}),
  'occumed:purpose': 'neutral shaded-relief texture beneath the fixed hex palette',
  'occumed:reference-color-pass': 5
};

const landcover = layer('landcover');
if (!landcover) throw new Error('The exported landcover layer is missing.');
landcover.paint ||= {};
landcover.paint['fill-color'] = [
  'match',
  ['get', 'class'],
  ['wood', 'forest'], HEX.forest,
  ['scrub', 'heath'], HEX.scrub,
  ['crop', 'farmland', 'orchard', 'vineyard'], HEX.farmland,
  ['grass', 'grassland', 'meadow'], HEX.grass,
  ['sand', 'desert'], HEX.desert,
  ['snow', 'ice', 'glacier'], HEX.snow,
  HEX.grass
];
landcover.paint['fill-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0, 0.54,
  4, 0.64,
  8, 0.74,
  10.5, 0.4,
  12, 0
];
landcover.paint['fill-antialias'] = false;

const landuse = layer('landuse');
if (landuse) {
  landuse.paint ||= {};
  landuse.paint['fill-color'] = [
    'match',
    ['get', 'class'],
    'agriculture', HEX.farmland,
    'wood', HEX.forest,
    'grass', HEX.grass,
    'scrub', HEX.scrub,
    'glacier', HEX.snow,
    'pitch', '#B5DD8E',
    'sand', HEX.desert,
    'park', '#99D17D',
    'airport', HEX.airport,
    'cemetery', '#BED4AA',
    'hospital', '#E7D7D5',
    'school', '#E8DCC1',
    'commercial_area', '#E4DAD2',
    'industrial', HEX.industrial,
    'rock', '#D8D2C1',
    'residential', HEX.urban,
    HEX.land
  ];
}

const park = layer('national-park');
if (park) {
  park.paint ||= {};
  park.paint['fill-color'] = HEX.park;
  park.paint['fill-opacity'] = [
    'interpolate',
    ['linear'],
    ['zoom'],
    5, 0,
    6, 0.3,
    9, 0.46,
    12, 0.22
  ];
}

const parkBand = layer('national-park_tint-band');
if (parkBand) {
  parkBand.paint ||= {};
  parkBand.paint['line-color'] = HEX.park;
}

const water = layer('water');
if (!water) throw new Error('The exported water layer is missing.');
water.paint ||= {};
water.paint['fill-color'] = HEX.water;
water.paint['fill-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0, 0.92,
  3, 0.95,
  5.5, 0.98,
  8, 1
];

for (const id of ['waterway', 'waterway-shadow']) {
  const candidate = layer(id);
  if (!candidate) continue;
  candidate.paint ||= {};
  candidate.paint['line-color'] = id === 'waterway' ? HEX.waterway : HEX.waterwayShadow;
}

for (const id of ['wetland', 'wetland-pattern']) {
  const candidate = layer(id);
  if (!candidate) continue;
  candidate.paint ||= {};
  candidate.paint['fill-color'] = HEX.wetland;
}

const hillshade = layer('occumed-hillshade');
if (!hillshade) throw new Error('The open hillshade layer is missing.');
hillshade.minzoom = 2.5;
hillshade.maxzoom = 16;
hillshade.paint = {
  'hillshade-exaggeration': [
    'interpolate',
    ['linear'],
    ['zoom'],
    2.5, 0.06,
    5.5, 0.12,
    7.5, 0.18,
    10, 0.24,
    13, 0.3,
    16, 0.2
  ],
  'hillshade-shadow-color': HEX.hillshadeShadow,
  'hillshade-highlight-color': HEX.hillshadeHighlight,
  'hillshade-accent-color': HEX.hillshadeAccent,
  'hillshade-illumination-direction': 335,
  'hillshade-illumination-anchor': 'map'
};

function setLineColor(id, color) {
  const candidate = layer(id);
  if (!candidate || candidate.type !== 'line') return;
  candidate.paint ||= {};
  candidate.paint['line-color'] = color;
}

for (const candidate of runtime.layers || []) {
  if (candidate.type !== 'line') continue;
  const originalSource = candidate.metadata?.['occumed:original-source-layer'];
  if (!['road', 'structure'].includes(originalSource)) continue;

  candidate.paint ||= {};
  const id = candidate.id.toLowerCase();
  if (id.includes('case')) candidate.paint['line-color'] = HEX.localRoad;
  else if (id.includes('motorway') || id.includes('trunk')) candidate.paint['line-color'] = HEX.motorway;
  else if (id.includes('primary')) candidate.paint['line-color'] = HEX.primaryRoad;
  else if (id.includes('secondary') || id.includes('tertiary')) candidate.paint['line-color'] = HEX.secondaryRoad;
  else if (id.includes('path') || id.includes('pedestrian') || id.includes('track')) candidate.paint['line-color'] = HEX.path;
  else candidate.paint['line-color'] = HEX.localRoad;
}

setLineColor('admin-0-boundary', HEX.borderCountry);
setLineColor('admin-0-boundary-disputed', HEX.borderCountry);
setLineColor('admin-1-boundary', HEX.borderState);

for (const candidate of runtime.layers || []) {
  if (candidate.type !== 'symbol') continue;
  candidate.paint ||= {};
  const id = candidate.id.toLowerCase();

  if (id.includes('water') || id.includes('marine')) {
    if ('text-color' in candidate.paint) candidate.paint['text-color'] = HEX.waterLabel;
  } else if (id.includes('state') || id.includes('continent')) {
    if ('text-color' in candidate.paint) candidate.paint['text-color'] = HEX.mutedLabel;
  } else if ('text-color' in candidate.paint) {
    candidate.paint['text-color'] = HEX.label;
  }

  if ('text-halo-color' in candidate.paint && !id.includes('water')) {
    candidate.paint['text-halo-color'] = HEX.halo;
  }
}

runtime.sky ||= {};
runtime.sky['sky-color'] = HEX.space;

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:reference-color-system': 'mapbox-screenshot-hex-v5',
  'occumed:reference-color-pass': 5,
  'occumed:live-visual-qa-pass': 5,
  'occumed:palette-format': 'fixed-hex'
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Applied screenshot hex pass 5: neutral relief, muted terrain, blue water, coral roads, dusty borders, and dark slate labels.');
