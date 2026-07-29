import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const layer = (id) => runtime.layers.find((candidate) => candidate.id === id);
const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
const byteHex = (value) => clampByte(value).toString(16).padStart(2, '0').toUpperCase();

function normalizeHex(value) {
  const raw = value.slice(1);
  if (raw.length === 3 || raw.length === 4) {
    return `#${raw.split('').map((character) => character.repeat(2)).join('').toUpperCase()}`;
  }
  if (raw.length === 6 || raw.length === 8) return `#${raw.toUpperCase()}`;
  return value;
}

function parseAlpha(value) {
  if (value === undefined) return 1;
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) return Math.max(0, Math.min(1, Number(trimmed.slice(0, -1)) / 100));
  return Math.max(0, Math.min(1, Number(trimmed)));
}

function rgbToHex(red, green, blue, alpha = 1) {
  const color = `#${byteHex(red)}${byteHex(green)}${byteHex(blue)}`;
  return alpha < 1 ? `${color}${byteHex(alpha * 255)}` : color;
}

function parseRgbChannel(value) {
  const trimmed = value.trim();
  return trimmed.endsWith('%') ? (Number(trimmed.slice(0, -1)) / 100) * 255 : Number(trimmed);
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1, saturation));
  const l = Math.max(0, Math.min(1, lightness));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - chroma / 2;

  let red = 0;
  let green = 0;
  let blue = 0;
  if (h < 60) [red, green] = [chroma, x];
  else if (h < 120) [red, green] = [x, chroma];
  else if (h < 180) [green, blue] = [chroma, x];
  else if (h < 240) [green, blue] = [x, chroma];
  else if (h < 300) [red, blue] = [x, chroma];
  else [red, blue] = [chroma, x];

  return [(red + m) * 255, (green + m) * 255, (blue + m) * 255];
}

function colorToHex(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return normalizeHex(trimmed);

  const rgbMatch = trimmed.match(/^rgba?\(\s*([^,]+),\s*([^,]+),\s*([^,\)]+)(?:,\s*([^\)]+))?\s*\)$/i);
  if (rgbMatch) {
    return rgbToHex(
      parseRgbChannel(rgbMatch[1]),
      parseRgbChannel(rgbMatch[2]),
      parseRgbChannel(rgbMatch[3]),
      parseAlpha(rgbMatch[4])
    );
  }

  const hslMatch = trimmed.match(/^hsla?\(\s*([^,]+),\s*([^,]+)%,\s*([^,]+)%(?:,\s*([^\)]+))?\s*\)$/i);
  if (hslMatch) {
    const [red, green, blue] = hslToRgb(
      Number(hslMatch[1]),
      Number(hslMatch[2]) / 100,
      Number(hslMatch[3]) / 100
    );
    return rgbToHex(red, green, blue, parseAlpha(hslMatch[4]));
  }

  const named = {
    transparent: '#00000000',
    black: '#000000',
    white: '#FFFFFF'
  };
  return named[trimmed.toLowerCase()] || value;
}

function normalizeColorLiterals(value) {
  if (Array.isArray(value)) return value.map(normalizeColorLiterals);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeColorLiterals(child)])
    );
  }
  return colorToHex(value);
}

function collectHexColors(value, colors = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) collectHexColors(child, colors);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectHexColors(child, colors);
  } else if (typeof value === 'string' && /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/.test(value)) {
    colors.add(value);
  }
  return colors;
}

function enterBy(candidate, zoom) {
  if (!candidate) return;
  candidate.minzoom = Math.min(candidate.minzoom ?? 24, zoom);
}

// The uploaded style remains the authority for every individual structure color.
// Convert its exact paint values to hex without combining roads, bridges, tunnels,
// buildings, land structures, transit, boundaries, labels, or natural features.
let normalizedLayers = 0;
for (const candidate of runtime.layers || []) {
  if (!candidate.paint) continue;
  candidate.paint = normalizeColorLiterals(candidate.paint);
  normalizedLayers += 1;
}
runtime.sky = normalizeColorLiterals(runtime.sky || {});

// Preserve each exported landcover color, but make those separate colors visible
// at globe and regional zooms. No fill-color is replaced here.
const land = layer('land');
if (land?.paint) land.paint['background-opacity'] = 1;

const landcover = layer('landcover');
if (landcover) {
  enterBy(landcover, 0);
  landcover.paint ||= {};
  landcover.paint['fill-opacity'] = [
    'interpolate',
    ['linear'],
    ['zoom'],
    0, 0.82,
    4, 0.86,
    8, 0.78,
    10.5, 0.52,
    12, 0.15
  ];
  landcover.paint['fill-antialias'] = false;
}

const landuse = layer('landuse');
if (landuse) {
  enterBy(landuse, 4.5);
  landuse.paint ||= {};
  landuse.paint['fill-opacity'] = [
    'interpolate',
    ['linear'],
    ['zoom'],
    4.5, 0,
    6, 0.34,
    9, 0.56,
    12, 0.72,
    15, 0.78
  ];
}

for (const id of ['national-park', 'national-park_tint-band', 'wetland', 'wetland-pattern']) {
  const candidate = layer(id);
  if (!candidate) continue;
  enterBy(candidate, id.startsWith('national-park') ? 4.5 : 6);
  candidate.paint ||= {};
  if (candidate.type === 'fill') {
    candidate.paint['fill-opacity'] = [
      'interpolate',
      ['linear'],
      ['zoom'],
      4.5, 0.18,
      7, 0.42,
      10, 0.54,
      13, 0.36
    ];
  }
}

// The exported water blue is already structure-specific. Make it opaque so it
// reads as the strong Mapbox-like water field instead of blending with beige.
const water = layer('water');
if (!water) throw new Error('The exported water layer is missing.');
water.paint ||= {};
water.paint['fill-opacity'] = 1;

// Bring the exported road and boundary hierarchy into view at the same scales as
// the supplied Studio references. Their individual line colors remain untouched.
const entryZooms = new Map([
  ['road-motorway-trunk', 2],
  ['road-motorway-trunk-case', 2],
  ['road-primary', 3.75],
  ['road-primary-case', 3.75],
  ['road-secondary-tertiary', 5],
  ['road-secondary-tertiary-case', 5],
  ['admin-0-boundary', 0],
  ['admin-0-boundary-disputed', 0],
  ['admin-0-boundary-bg', 0],
  ['admin-1-boundary', 2],
  ['admin-1-boundary-bg', 2],
  ['country-label', 0],
  ['state-label', 1.5],
  ['settlement-major-label', 2.5]
]);
for (const [id, zoom] of entryZooms) enterBy(layer(id), zoom);

for (const [id, opacity] of [
  ['admin-0-boundary', 0.82],
  ['admin-0-boundary-disputed', 0.82],
  ['admin-0-boundary-bg', 0.72],
  ['admin-1-boundary', 0.58],
  ['admin-1-boundary-bg', 0.48]
]) {
  const candidate = layer(id);
  if (!candidate || candidate.type !== 'line') continue;
  candidate.paint ||= {};
  candidate.paint['line-opacity'] = opacity;
}

const layerColors = collectHexColors((runtime.layers || []).map((candidate) => candidate.paint || {}));
runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:reference-color-system': 'exported-per-layer-visible-v7',
  'occumed:reference-color-pass': 7,
  'occumed:live-visual-qa-pass': 7,
  'occumed:palette-format': 'fixed-hex-per-layer',
  'occumed:layer-specific-palette': true,
  'occumed:visible-low-zoom-cartography': true,
  'occumed:normalized-paint-layers': normalizedLayers,
  'occumed:distinct-layer-color-count': layerColors.size
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(
  `Preserved ${layerColors.size} exported structure-specific colors and restored visible low-zoom landcover, water, terrain, roads, and boundaries.`
);
