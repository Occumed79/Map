import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);

const land = layer('land');
if (!land) throw new Error('The exported land background layer is missing.');
land.paint ||= {};
land.paint['background-color'] = 'hsl(68, 28%, 83%)';
land.paint['background-opacity'] = 1;

const relief = layer('occumed-shaded-relief');
if (!relief) throw new Error('The open shaded-relief layer is missing.');
relief.maxzoom = 9.5;
relief.paint = {
  'raster-opacity': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    0.72,
    2.5,
    0.64,
    4.5,
    0.46,
    6.5,
    0.24,
    8,
    0.1,
    9.5,
    0
  ],
  'raster-saturation': 0.92,
  'raster-contrast': 0.18,
  'raster-hue-rotate': -8,
  'raster-brightness-min': 0.03,
  'raster-brightness-max': 0.91,
  'raster-resampling': 'linear',
  'raster-fade-duration': 0
};
relief.metadata = {
  ...(relief.metadata || {}),
  'occumed:purpose': 'reference-calibrated low-zoom terrain and bathymetry color',
  'occumed:reference-color-pass': 4
};

const landcover = layer('landcover');
if (!landcover) throw new Error('The exported landcover layer is missing.');
landcover.paint ||= {};
landcover.paint['fill-color'] = [
  'match',
  ['get', 'class'],
  ['wood', 'forest'],
  'hsla(103, 48%, 57%, 0.82)',
  ['scrub', 'heath'],
  'hsla(98, 43%, 67%, 0.66)',
  ['crop', 'farmland', 'orchard', 'vineyard'],
  'hsla(72, 48%, 69%, 0.62)',
  ['grass', 'grassland', 'meadow'],
  'hsla(98, 46%, 72%, 0.64)',
  ['sand', 'desert'],
  'hsl(58, 36%, 81%)',
  ['snow', 'ice', 'glacier'],
  'hsl(205, 35%, 96%)',
  'hsla(98, 40%, 66%, 0.55)'
];
landcover.paint['fill-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0,
  0.68,
  4,
  0.76,
  8,
  0.82,
  10.5,
  0.42,
  12,
  0
];
landcover.paint['fill-antialias'] = false;

const park = layer('national-park');
if (park) {
  park.paint ||= {};
  park.paint['fill-color'] = 'hsl(98, 45%, 64%)';
  park.paint['fill-opacity'] = [
    'interpolate',
    ['linear'],
    ['zoom'],
    5,
    0,
    6,
    0.42,
    9,
    0.58,
    12,
    0.24
  ];
}

const parkBand = layer('national-park_tint-band');
if (parkBand) {
  parkBand.paint ||= {};
  parkBand.paint['line-color'] = 'hsl(98, 45%, 64%)';
}

const water = layer('water');
if (!water) throw new Error('The exported water layer is missing.');
water.paint ||= {};
water.paint['fill-color'] = 'hsl(205, 76%, 66%)';
water.paint['fill-opacity'] = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0,
  0.9,
  3,
  0.93,
  5.5,
  0.96,
  8,
  0.99,
  10,
  1
];

for (const id of ['waterway', 'waterway-shadow']) {
  const candidate = layer(id);
  if (!candidate) continue;
  candidate.paint ||= {};
  candidate.paint['line-color'] = id === 'waterway' ? 'hsl(205, 76%, 64%)' : 'hsl(222, 69%, 66%)';
}

for (const id of ['wetland', 'wetland-pattern']) {
  const candidate = layer(id);
  if (!candidate) continue;
  candidate.paint ||= {};
  candidate.paint['fill-color'] = 'hsl(194, 42%, 72%)';
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
    2.5,
    0.1,
    5.5,
    0.2,
    7.5,
    0.3,
    10,
    0.34,
    13,
    0.28,
    16,
    0.16
  ],
  'hillshade-shadow-color': 'rgba(47, 74, 55, 0.5)',
  'hillshade-highlight-color': 'rgba(250, 247, 224, 0.42)',
  'hillshade-accent-color': 'rgba(82, 128, 72, 0.44)',
  'hillshade-illumination-direction': 335,
  'hillshade-illumination-anchor': 'map'
};

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:reference-color-system': 'mapbox-photo-reference-v4',
  'occumed:reference-color-pass': 4,
  'occumed:live-visual-qa-pass': 4
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Applied reference color pass 4: greener land, restrained forests, stronger terrain, richer water, and visible bathymetry.');
