import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const palette = {
  space: '#03070b',
  waterLow: '#3b9edb',
  waterMid: '#55aee3',
  waterHigh: '#70bce8',
  land: 'hsl(72, 38%, 79%)',
  forest: '#79c963',
  grass: '#b9dc96',
  scrub: '#cbdca4',
  crop: '#d9e2a9',
  wetland: '#9fd2a3',
  snow: '#f3f5f1',
  park: '#86d06b',
  urban: '#e5e2d6',
  industrial: '#d7d8de',
  commercial: '#e8d6c9',
  institutional: '#eadbcf',
  waterway: '#55a9df',
  label: '#2f3335',
  mutedLabel: '#66737b',
  waterLabel: '#f1f9ff',
  halo: '#f5f3e7'
};

const lowZoomMinimums = new Map([
  ['road-motorway-trunk', 1.5],
  ['road-primary', 2.15],
  ['road-secondary-tertiary', 3.1],
  ['country-label', 0],
  ['state-label', 1.55],
  ['settlement-major-label', 2.05]
]);

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
  'horizon-color': 'rgba(245, 253, 255, 1)',
  'fog-color': 'rgba(168, 220, 247, 0.035)',
  'sky-horizon-blend': [
    'interpolate', ['linear'], ['zoom'],
    0, 0.135,
    2.5, 0.11,
    4.5, 0.04,
    6, 0
  ],
  'horizon-fog-blend': 0,
  'fog-ground-blend': 0,
  'atmosphere-blend': [
    'interpolate', ['linear'], ['zoom'],
    0, 0.18,
    2.5, 0.15,
    4.5, 0.06,
    6, 0
  ]
};
delete runtime.fog;
delete runtime.light;

for (const layer of runtime.layers || []) {
  const id = lower(layer.id);
  const paint = ensurePaint(layer);

  if (lowZoomMinimums.has(id)) {
    layer.minzoom = Math.min(layer.minzoom ?? 24, lowZoomMinimums.get(id));
  }

  if (layer.type === 'background') {
    paint['background-color'] = palette.land;
    paint['background-opacity'] = 1;
    continue;
  }

  if (layer.id === 'occumed-shaded-relief') {
    layer.maxzoom = 7;
    layer.paint = {
      'raster-opacity': [
        'interpolate', ['linear'], ['zoom'],
        0, 0.34,
        2.5, 0.31,
        4.5, 0.22,
        6.5, 0
      ],
      'raster-saturation': 0.72,
      'raster-contrast': 0.16,
      'raster-brightness-min': 0.02,
      'raster-brightness-max': 0.96,
      'raster-resampling': 'linear',
      'raster-fade-duration': 0
    };
    layer.metadata = {
      ...(layer.metadata || {}),
      'occumed:purpose': 'photo-calibrated bathymetry and low-zoom relief',
      'occumed:reference': 'Mapbox Studio screenshot set supplied 2026-07-25',
      'occumed:live-qa-pass': 2
    };
    continue;
  }

  if (layer.id === 'occumed-hillshade') {
    layer.minzoom = 3;
    layer.maxzoom = 16;
    layer.paint = {
      'hillshade-exaggeration': [
        'interpolate', ['linear'], ['zoom'],
        3, 0.04,
        6, 0.11,
        10, 0.21,
        14, 0.27,
        16, 0.18
      ],
      'hillshade-shadow-color': 'rgba(52, 79, 58, 0.5)',
      'hillshade-highlight-color': 'rgba(250, 247, 224, 0.4)',
      'hillshade-accent-color': 'rgba(80, 135, 70, 0.4)',
      'hillshade-illumination-direction': 335,
      'hillshade-illumination-anchor': 'map'
    };
    continue;
  }

  if (id === 'landcover' || isSourceLayer(layer, 'landcover')) {
    if (layer.type === 'fill') {
      paint['fill-color'] = [
        'match', ['get', 'class'],
        ['wood', 'forest'], palette.forest,
        ['grass', 'grassland', 'meadow'], palette.grass,
        ['farmland', 'crop', 'orchard', 'vineyard'], palette.crop,
        ['scrub', 'heath'], palette.scrub,
        ['sand', 'desert'], '#e8dfb6',
        ['wetland', 'marsh'], palette.wetland,
        ['ice', 'snow', 'glacier'], palette.snow,
        palette.grass
      ];
      paint['fill-opacity'] = [
        'interpolate', ['linear'], ['zoom'],
        0, 0.93,
        4, 0.96,
        8, 0.98,
        13, 0.94
      ];
    }
    continue;
  }

  if (id === 'national-park' || id.includes('national-park')) {
    if (layer.type === 'fill') {
      paint['fill-color'] = palette.park;
      paint['fill-opacity'] = [
        'interpolate', ['linear'], ['zoom'],
        3, 0.64,
        8, 0.8,
        13, 0.88
      ];
    }
    continue;
  }

  if (id === 'landuse' || isSourceLayer(layer, 'landuse') || isSourceLayer(layer, 'park')) {
    if (layer.type === 'fill') {
      paint['fill-color'] = [
        'match', ['coalesce', ['get', 'class'], ''],
        ['park', 'recreation_ground', 'garden', 'playground', 'golf_course'], palette.park,
        ['residential', 'suburb', 'neighbourhood'], palette.urban,
        ['industrial', 'railway'], palette.industrial,
        ['commercial', 'retail'], palette.commercial,
        ['school', 'university', 'hospital', 'college'], palette.institutional,
        ['cemetery'], '#c5ddbb',
        ['farmland', 'farmyard'], palette.crop,
        palette.urban
      ];
      paint['fill-opacity'] = [
        'interpolate', ['linear'], ['zoom'],
        5, 0.28,
        9, 0.58,
        13, 0.8
      ];
    }
    continue;
  }

  if (id === 'water' || (layer.type === 'fill' && isSourceLayer(layer, 'water'))) {
    paint['fill-color'] = [
      'interpolate', ['linear'], ['zoom'],
      0, palette.waterLow,
      6, palette.waterMid,
      12, palette.waterHigh
    ];
    paint['fill-opacity'] = [
      'interpolate', ['linear'], ['zoom'],
      0, 0.82,
      3.5, 0.86,
      7, 0.94,
      10, 1
    ];
    continue;
  }

  if (isSourceLayer(layer, 'waterway') && layer.type === 'line') {
    paint['line-color'] = palette.waterway;
    paint['line-opacity'] = 0.96;
  }

  if (id === 'admin-0-boundary' && layer.type === 'line') {
    paint['line-color'] = '#c47f8a';
    paint['line-opacity'] = 0.76;
  } else if (id === 'admin-1-boundary' && layer.type === 'line') {
    paint['line-color'] = '#d19aa0';
    paint['line-opacity'] = 0.6;
  }

  if (id === 'road-motorway-trunk' && layer.type === 'line') {
    paint['line-opacity'] = 0.94;
  } else if (id === 'road-primary' && layer.type === 'line') {
    paint['line-opacity'] = 0.9;
  }

  if (layer.type === 'symbol') {
    const layout = ensureLayout(layer);
    paint['text-opacity'] = 1;

    if (id.includes('country-label')) {
      paint['text-color'] = palette.label;
      paint['text-halo-color'] = palette.halo;
      paint['text-halo-width'] = 1.2;
      layout['text-font'] = ['Open Sans Semibold', 'Noto Sans Regular'];
    } else if (id.includes('state-label') || id.includes('continent-label')) {
      paint['text-color'] = palette.mutedLabel;
      paint['text-halo-color'] = 'rgba(245, 243, 231, 0.8)';
      paint['text-halo-width'] = 0.95;
      layout['text-font'] = ['Open Sans Regular', 'Noto Sans Regular'];
    } else if (id.includes('settlement-major-label')) {
      paint['text-color'] = palette.label;
      paint['text-halo-color'] = palette.halo;
      paint['text-halo-width'] = 1.15;
      layout['text-font'] = ['Open Sans Semibold', 'Noto Sans Regular'];
    } else if (id.includes('settlement-minor-label') || id.includes('settlement-subdivision-label')) {
      paint['text-color'] = '#4d555b';
      paint['text-halo-color'] = 'rgba(245, 243, 231, 0.9)';
      paint['text-halo-width'] = 1;
      layout['text-font'] = ['Open Sans Regular', 'Noto Sans Regular'];
    }

    if (/water|ocean|sea|bay|strait|river/.test(id)) {
      paint['text-color'] = palette.waterLabel;
      paint['text-halo-color'] = 'rgba(44, 126, 181, 0.5)';
      paint['text-halo-width'] = 0.8;
    }
  }
}

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:photo-reference-rebuild': true,
  'occumed:photo-reference-date': '2026-07-25',
  'occumed:mapbox-runtime-dependency': false,
  'occumed:live-visual-qa-pass': 2,
  'occumed:reference-coverage': [
    'globe', 'bathymetry', 'polar', 'desert', 'forest',
    'regional', 'urban', 'coastal', 'street', 'park'
  ]
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log('Applied live visual-QA pass 2 for globe framing, ocean depth, landcover, terrain, roads, boundaries, and labels.');
