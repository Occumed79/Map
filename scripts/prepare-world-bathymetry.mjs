#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--input-dir') options.inputDir = argv[++index];
    else if (key === '--output') options.output = argv[++index];
  }
  for (const required of ['inputDir', 'output']) {
    if (!options[required]) throw new Error(`Missing --${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.`);
  }
  return options;
}

function depthFromFilename(filename) {
  const match = filename.match(/bathymetry_[A-L]_(\d+)\.geojson$/);
  if (!match) return null;
  return Number(match[1]);
}

const options = parseArgs(process.argv.slice(2));
const entries = (await fs.readdir(options.inputDir))
  .map((filename) => ({ filename, depth: depthFromFilename(filename) }))
  .filter((entry) => entry.depth !== null)
  .sort((left, right) => left.depth - right.depth);

if (entries.length !== 12) {
  throw new Error(`Expected 12 Natural Earth bathymetry bands; found ${entries.length}.`);
}

const features = [];
for (const entry of entries) {
  const inputPath = path.join(options.inputDir, entry.filename);
  const collection = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error(`${entry.filename} is not a GeoJSON FeatureCollection.`);
  }
  for (const feature of collection.features) {
    if (!feature?.geometry) continue;
    features.push({
      type: 'Feature',
      properties: { min_depth: entry.depth },
      geometry: feature.geometry
    });
  }
}

await fs.writeFile(
  options.output,
  `${JSON.stringify({ type: 'FeatureCollection', features })}\n`
);
console.log(
  `Prepared ${features.length} nested bathymetry polygons from ${entries.length} depth bands.`
);
