import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const FOUNDATION_LAYERS = new Set(['land', 'landcover', 'depth']);
const PERMANENT_TILE_PATTERN = '/tiles/{z}/{x}/{y}.pbf';

function sourceLayerName(layer) {
  return String(
    layer?.['source-layer'] ||
    layer?.metadata?.['occumed:open-source-layer'] ||
    ''
  ).toLowerCase();
}

function isPermanentWorldwideSource(source) {
  return source?.type === 'vector' &&
    Array.isArray(source.tiles) &&
    source.tiles.some((url) => String(url).includes(PERMANENT_TILE_PATTERN));
}

let permanentSources = 0;
for (const source of Object.values(runtime.sources || {})) {
  if (!isPermanentWorldwideSource(source)) continue;

  // Mapbox/TileJSON semantics: source maxzoom describes the highest tile zoom
  // available. The renderer may overscale those tiles above that zoom. Our
  // virtual endpoint resolves through z16, so expose one uninterrupted source
  // pyramid across the application's complete camera range.
  source.minzoom = 0;
  source.maxzoom = 16;
  source.scheme = 'xyz';
  permanentSources += 1;
}

if (permanentSources !== 1) {
  throw new Error(`Expected exactly one permanent worldwide vector source; found ${permanentSources}.`);
}

// Prevent runtime paint-value changes from introducing an additional delayed
// fade. Zoom expressions still interpolate continuously; explicit style
// mutations apply immediately.
runtime.transition = { duration: 0, delay: 0 };

let foundationLayers = 0;
let landcoverLayers = 0;
let depthLayers = 0;
for (const layer of runtime.layers || []) {
  const sourceLayer = sourceLayerName(layer);
  if (!FOUNDATION_LAYERS.has(sourceLayer)) continue;

  layer.minzoom = 0;
  delete layer.maxzoom;
  layer.layout ||= {};
  layer.layout.visibility = 'visible';
  layer.metadata = {
    ...(layer.metadata || {}),
    'occumed:continuous-foundation': true,
    'occumed:documented-overscaling-contract': true
  };
  foundationLayers += 1;

  if (sourceLayer === 'landcover' && layer.type === 'fill') {
    layer.paint ||= {};
    layer.paint['fill-opacity'] = [
      'interpolate', ['linear'], ['zoom'],
      0, 0.92,
      6, 0.88,
      10, 0.82,
      16, 0.82
    ];
    landcoverLayers += 1;
  }

  if (sourceLayer === 'depth' && layer.type === 'fill') {
    layer.paint ||= {};
    const existingOpacity = layer.paint['fill-opacity'] ?? 1;
    // Preserve each bathymetry band's authored opacity while preventing any
    // exported high-zoom expression from reducing the layer to zero.
    layer.paint['fill-opacity'] = ['max', 0.06, existingOpacity];
    depthLayers += 1;
  }
}

if (!foundationLayers || !landcoverLayers || !depthLayers) {
  throw new Error(
    `Incomplete documented rendering contract: ${foundationLayers} foundation, ` +
    `${landcoverLayers} landcover, ${depthLayers} depth layers.`
  );
}

runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:mapbox-style-contract-applied': true,
  'occumed:single-source-minzoom': 0,
  'occumed:single-source-maxzoom': 16,
  'occumed:foundation-layer-maxzoom': null,
  'occumed:style-transition-duration-ms': 0
};

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(
  `Applied documented single-source rendering contract to ${foundationLayers} foundation layers ` +
  `(${landcoverLayers} landcover, ${depthLayers} depth).`
);
