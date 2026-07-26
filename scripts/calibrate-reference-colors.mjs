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

// restore-exported-cartography.mjs has already restored the complete exported
// paint object for every compatible layer. Convert those exact color literals
// to hex in place; do not collapse roads, tunnels, bridges, buildings, landuse,
// boundaries, labels, or any other structures into broad color categories.
let normalizedLayers = 0;
for (const candidate of runtime.layers || []) {
  if (!candidate.paint) continue;
  candidate.paint = normalizeColorLiterals(candidate.paint);
  normalizedLayers += 1;
}
runtime.sky = normalizeColorLiterals(runtime.sky || {});

// The open shaded-relief raster is not part of the exported vector palette.
// Keep it neutral and subtle so it adds terrain texture without recoloring land.
const relief = layer('occumed-shaded-relief');
if (!relief) throw new Error('The open shaded-relief layer is missing.');
relief.maxzoom = 8;
relief.paint = {
  'raster-opacity': [
    'interpolate',
    ['linear'],
    ['zoom'],
    0, 0.16,
    2.5, 0.13,
    4.5, 0.09,
    6.5, 0.04,
    8, 0
  ],
  'raster-saturation': -1,
  'raster-contrast': 0.04,
  'raster-hue-rotate': 0,
  'raster-brightness-min': 0.2,
  'raster-brightness-max': 0.94,
  'raster-resampling': 'linear',
  'raster-fade-duration': 0
};
relief.metadata = {
  ...(relief.metadata || {}),
  'occumed:purpose': 'neutral terrain texture beneath the exported per-layer palette',
  'occumed:reference-color-pass': 6
};

// Hillshade is also an independent replacement source. These restrained colors
// shape the terrain while leaving all exported structure colors untouched.
const hillshade = layer('occumed-hillshade');
if (!hillshade) throw new Error('The open hillshade layer is missing.');
hillshade.minzoom = 2.5;
hillshade.maxzoom = 16;
hillshade.paint = {
  'hillshade-exaggeration': [
    'interpolate',
    ['linear'],
    ['zoom'],
    2.5, 0.05,
    5.5, 0.11,
    7.5, 0.18,
    10, 0.25,
    13, 0.3,
    16, 0.2
  ],
  'hillshade-shadow-color': '#52685B',
  'hillshade-highlight-color': '#FFF8E8',
  'hillshade-accent-color': '#6E8D69',
  'hillshade-illumination-direction': 335,
  'hillshade-illumination-anchor': 'map'
};

const layerColors = collectHexColors((runtime.layers || []).map((candidate) => candidate.paint || {}));
runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:reference-color-system': 'exported-per-layer-hex-v6',
  'occumed:reference-color-pass': 6,
  'occumed:live-visual-qa-pass': 6,
  'occumed:palette-format': 'fixed-hex-per-layer',
  'occumed:layer-specific-palette': true,
  'occumed:normalized-paint-layers': normalizedLayers,
  'occumed:distinct-layer-color-count': layerColors.size
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(
  `Preserved the exported structure-specific palette as hex across ${normalizedLayers} painted layers (${layerColors.size} distinct colors); neutralized only the independent relief sources.`
);
