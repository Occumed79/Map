import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const palette = {
  space: '#05080c',
  waterLow: '#55a7df',
  waterMid: '#68afe0',
  waterHigh: '#76b8e4',
  land: '#e7e7d5',
  forest: '#8ecf76',
  denseForest: '#7fc86a',
  grass: '#b8d99c',
  scrub: '#c7dda5',
  crop: '#d7e1b6',
  wetland: '#a7d4aa',
  snow: '#f3f5f3',
  park: '#92d47a',
  urban: '#e2e1d8',
  industrial: '#d7d8de',
  commercial: '#e8d6c9',
  institutional: '#eadbcf',
  waterway: '#62aee3',
  label: '#2f3335',
  mutedLabel: '#63717a',
  waterLabel: '#eef8ff',
  halo: '#f4f3e9'
};

function lower(value) {
  return String(value || '').toLowerCase();
}

function isSourceLayer(layer, name) {
  return lower(layer['source-layer']) === name || lower(layer.metadata?.['occumed:open-source-layer']) === name;
}

function ensurePaint(layer) {
  layer.paint ||= {};
  return layer.paint;
}

function ensureLayout(layer) {
  layer.layout ||= {};
  return layer.layout;
}

runtime.projection = { type: 'globe' };
runtime.sky = {
  'sky-color': palette.space,
  'horizon-color': 'rgba(250, 254, 255, 1)',
  'fog-color': 'rgba(168, 220, 247, 0.025)',
  'sky-horizon-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    0.075,
    2.5,
    0.06,
    4.5,
    0.025,
    6,
    0
  ],
  'horizon-fog-blend': 0,
  'fog-ground-blend': 0,
  'atmosphere-blend': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    0.14,
    2.5,
    0.11,
    4.5,
    0.045,
    6,
    0
  ]
};
delete runtime.fog;
delete runtime.light;

for (const layer of runtime.layers || []) {
  const id = lower(layer.id);
  const paint = ensurePaint(layer);

  if (layer.type === 'background') {
    paint['background-color'] = palette.waterLow;
    paint['background-opacity'] = 1;
    continue;
  }

  if (layer.id === 'occumed-shaded-relief') {
    layer.maxzoom = 7;
    layer.paint = {
      'raster-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        0,
        0.72,
        2.5,
        0.64,
        4.5,
        0.48,
        6.5,
        0
      ],
      'raster-saturation': 0.32,
      'raster-contrast': 0.1,
      'raster-brightness-min': 0.04,
      'raster-brightness-max': 0.93,
      'raster-resampling': 'linear',
      'raster-fade-duration': 0
    };
    layer.metadata = {
      ...(layer.metadata || {}),
      'occumed:purpose': 'photo-calibrated bathymetry and low-zoom relief',
      'occumed:reference': 'Mapbox Studio screenshot set supplied 2026-07-25'
    };
    continue;
  }

  if (layer.id === 'occumed-hillshade') {
    layer.minzoom = 3;
    layer.maxzoom = 16;
    layer.paint = {
      'hillshade-exaggeration': [
        'interpolate',
        ['linear'],
        ['zoom'],
        3,
        0.03,
        6,
        0.09,
        10,
        0.2,
        14,
        0.26,
        16,
        0.18
      ],
      'hillshade-shadow-color': 'rgba(59, 84, 63, 0.48)',
      'hillshade-highlight-color': 'rgba(248, 246, 224, 0.38)',
      'hillshade-accent-color': 'rgba(87, 139, 75, 0.38)',
      'hillshade-illumination-direction': 335,
      'hillshade-illumination-anchor': 'map'
    };
    continue;
  }

  if (id === 'land') {
    paint['fill-color'] = palette.land;
    paint['fill-opacity'] = 1;
    continue;
  }

  if (id === 'landcover' || isSourceLayer(layer, 'landcover')) {
    if (layer.type === 'fill') {
      paint['fill-color'] = [
        'match',
        ['get', 'class'],
        ['wood', 'forest'],
        palette.forest,
        ['grass', 'grassland', 'meadow'],
        palette.grass,
        ['farmland', 'crop', 'orchard', 'vineyard'],
        palette.crop,
        ['scrub', 'heath', 'sand'],
        palette.scrub,
        ['wetland', 'marsh'],
        palette.wetland,
        ['ice', 'snow', 'glacier'],
        palette.snow,
        palette.grass
      ];
      paint['fill-opacity'] = [
        'interpolate',
        ['linear'],
        ['zoom'],
        0,
        0.84,
        4,
        0.9,
        8,
        0.94,
        13,
        0.9
      ];
    }
    continue;
  }

  if (id === 'national-park' || id.includes('national-park')) {
    if (layer.type === 'fill') {
      paint['fill-color'] = palette.park;
      paint['fill-opacity'] = [
        'interpolate',
        ['linear'],
        ['zoom'],
        3,
        0.58,
        8,
        0.76,
        13,
        0.84
      ];
    }
    continue;
  }

  if (id === 'landuse' || isSourceLayer(layer, 'landuse') || isSourceLayer(layer, 'park')) {
    if (layer.type === 'fill') {
      paint['fill-color'] = [
        'match',
        ['coalesce', ['get', 'class'], ''],
        ['park', 'recreation_ground', 'garden', 'playground', 'golf_course'],
        palette.park,
        ['residential', 'suburb', 'neighbourhood'],
        palette.urban,
        ['industrial', 'railway'],
        palette.industrial,
        ['commercial', 'retail'],
        palette.commercial,
        ['school', 'university', 'hospital', 'college'],
        palette.institutional,
        ['cemetery'],
        '#c5ddbb',
        ['farmland', 'farmyard'],
        palette.crop,
        palette.urban
      ];
      paint['fill-opacity'] = [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        0.25,
        9,
        0.55,
        13,
        0.78
      ];
    }
    continue;
  }

  if (id === 'water' || (layer.type === 'fill' && isSourceLayer(layer, 'water'))) {
    paint['fill-color'] = [
      'interpolate',
      ['linear'],
      ['zoom'],
      0,
      palette.waterLow,
      6,
      palette.waterMid,
      12,
      palette.waterHigh
    ];
    paint['fill-opacity'] = 1;
    continue;
  }

  if (isSourceLayer(layer, 'waterway') && layer.type === 'line') {
    paint['line-color'] = palette.waterway;
    paint['line-opacity'] = 0.95;
  }

  if (layer.type === 'symbol') {
    const layout = ensureLayout(layer);

    if (id.includes('country-label')) {
      paint['text-color'] = palette.label;
      paint['text-halo-color'] = palette.halo;
      paint['text-halo-width'] = 1.15;
      layout['text-font'] = ['Open Sans Semibold', 'Noto Sans Regular'];
    } else if (id.includes('state-label') || id.includes('continent-label')) {
      paint['text-color'] = palette.mutedLabel;
      paint['text-halo-color'] = 'rgba(244, 243, 233, 0.72)';
      paint['text-halo-width'] = 0.9;
      layout['text-font'] = ['Open Sans Regular', 'Noto Sans Regular'];
    } else if (id.includes('settlement-major-label')) {
      paint['text-color'] = palette.label;
      paint['text-halo-color'] = palette.halo;
      paint['text-halo-width'] = 1.1;
      layout['text-font'] = ['Open Sans Semibold', 'Noto Sans Regular'];
    } else if (id.includes('settlement-minor-label') || id.includes('settlement-subdivision-label')) {
      paint['text-color'] = '#4d555b';
      paint['text-halo-color'] = 'rgba(244, 243, 233, 0.86)';
      paint['text-halo-width'] = 0.95;
      layout['text-font'] = ['Open Sans Regular', 'Noto Sans Regular'];
    }

    if (/water|ocean|sea|bay|strait|river/.test(id)) {
      paint['text-color'] = palette.waterLabel;
      paint['text-halo-color'] = 'rgba(69, 143, 192, 0.42)';
      paint['text-halo-width'] = 0.75;
    }
  }
}

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:photo-reference-rebuild': true,
  'occumed:photo-reference-date': '2026-07-25',
  'occumed:mapbox-runtime-dependency': false,
  'occumed:reference-coverage': [
    'globe',
    'bathymetry',
    'polar',
    'desert',
    'forest',
    'regional',
    'urban',
    'coastal',
    'street',
    'park'
  ]
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Applied screenshot-calibrated globe, water, landcover, relief, hillshade, and label styling.');
