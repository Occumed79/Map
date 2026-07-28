#!/usr/bin/env node

import fs from 'node:fs/promises';

const SURFACE_MAX_ZOOM = 10;

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
      maxzoom: SURFACE_MAX_ZOOM
    }
  };
}

const options = parseArgs(process.argv.slice(2));
const [land, geography, glaciers] = await Promise.all([
  readCollection(options.land),
  readCollection(options.geography),
  readCollection(options.glaciers)
]);

// This is the permanent worldwide vegetation/terrain-class foundation. It must
// survive the overview-to-regional routing boundary and remain present through
// the physical surface archive's native maximum zoom. Regional landuse, parks,
// roads, labels, and buildings add detail above it; they never replace it.
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

if (!features.length) throw new Error('Worldwide landcover preparation produced no features.');
for (const feature of features) {
  if (feature.tippecanoe?.minzoom !== 0 || feature.tippecanoe?.maxzoom !== SURFACE_MAX_ZOOM) {
    throw new Error('Worldwide landcover contains a zoom cutoff that can switch the physical foundation.');
  }
}

await fs.writeFile(
  options.output,
  `${JSON.stringify({ type: 'FeatureCollection', features })}\n`
);

const classCounts = features.reduce((counts, feature) => {
  const className = feature.properties.class;
  counts[className] = (counts[className] || 0) + 1;
  return counts;
}, {});
console.log(
  `Prepared continuous worldwide landcover through zoom ${SURFACE_MAX_ZOOM}: ${JSON.stringify(classCounts)}.`
);
