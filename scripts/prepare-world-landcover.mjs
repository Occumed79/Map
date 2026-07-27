#!/usr/bin/env node

import fs from 'node:fs/promises';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--land') options.land = argv[++index];
    else if (key === '--geography') options.geography = argv[++index];
    else if (key === '--glaciers') options.glaciers = argv[++index];
    else if (key === '--output') options.output = argv[++index];
  }
  for (const required of ['land', 'geography', 'glaciers', 'output']) {
    if (!options[required]) throw new Error(`Missing --${required}.`);
  }
  return options;
}

async function readCollection(filename) {
  const collection = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error(`${filename} is not a GeoJSON FeatureCollection.`);
  }
  return collection;
}

function classifiedFeature(feature, className) {
  if (!feature?.geometry) return null;
  return {
    type: 'Feature',
    properties: { class: className },
    geometry: feature.geometry,
    tippecanoe: {
      minzoom: 0,
      maxzoom: 5
    }
  };
}

const options = parseArgs(process.argv.slice(2));
const [land, geography, glaciers] = await Promise.all([
  readCollection(options.land),
  readCollection(options.geography),
  readCollection(options.glaciers)
]);

// The exact exported land chip is the neutral base. This generalized layer
// supplies the vegetation, desert, tundra, and ice classes that give the globe
// the same green physical identity before the detailed regional landcover
// takes over. It uses the same `landcover` schema as the regional shards.
const features = [
  ...land.features.map((feature) => classifiedFeature(feature, 'grass')),
  ...geography.features
    .filter((feature) => feature?.properties?.FEATURECLA === 'Desert')
    .map((feature) => classifiedFeature(feature, 'sand')),
  ...geography.features
    .filter((feature) => feature?.properties?.FEATURECLA === 'Tundra')
    .map((feature) => classifiedFeature(feature, 'scrub')),
  ...glaciers.features.map((feature) => classifiedFeature(feature, 'snow'))
].filter(Boolean);

await fs.writeFile(
  options.output,
  `${JSON.stringify({ type: 'FeatureCollection', features })}\n`
);

const classCounts = features.reduce((counts, feature) => {
  const className = feature.properties.class;
  counts[className] = (counts[className] || 0) + 1;
  return counts;
}, {});
console.log(`Prepared generalized worldwide landcover: ${JSON.stringify(classCounts)}.`);
