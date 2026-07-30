#!/usr/bin/env node

import fs from 'node:fs/promises';

const [family, outputPath] = process.argv.slice(2);
if (!family || !outputPath) {
  throw new Error('Usage: node scripts/select-geofabrik-region-geometry.mjs <family> <output.geojson>');
}

const indexUrl = process.env.GEOFABRIK_INDEX_URL || 'https://download.geofabrik.de/index-v1.json';
const response = await fetch(indexUrl, {
  headers: { 'User-Agent': 'Occu-Med-Map/offline-owner-compiler' }
});
if (!response.ok) throw new Error(`Unable to load Geofabrik index (${response.status}).`);
const index = await response.json();
const feature = (index.features || []).find((candidate) => candidate?.properties?.id === family);
if (!feature?.geometry) throw new Error(`Geofabrik geometry not found for ${family}.`);
const pbfUrl = feature.properties?.urls?.pbf;
if (!pbfUrl) throw new Error(`Geofabrik PBF URL not found for ${family}.`);

const output = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: {
      id: family,
      name: feature.properties?.name || family,
      pbf_url: pbfUrl
    },
    geometry: feature.geometry
  }]
};
await fs.writeFile(outputPath, `${JSON.stringify(output)}\n`);
console.log(`Selected exact Geofabrik geometry for ${family}.`);
