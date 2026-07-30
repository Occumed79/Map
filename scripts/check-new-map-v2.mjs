#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const [main, mapSource, css, server, packageJson] = await Promise.all([
  fs.readFile(path.join(root, 'src', 'main.js'), 'utf8'),
  fs.readFile(path.join(root, 'src', 'new-map-v2.js'), 'utf8'),
  fs.readFile(path.join(root, 'src', 'new-map-v2.css'), 'utf8'),
  fs.readFile(path.join(root, 'server-new-map-v2.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse)
]);

expect(main.includes("./new-map-v2.js"), 'Application entry point does not use the replacement renderer.');
expect(main.includes("./new-map-v2.css"), 'Application entry point does not use the replacement stylesheet.');
expect(!main.includes('occumed-map.js'), 'Legacy PMTiles-aware map renderer is still active.');
expect(!main.includes('flat-overview.css'), 'Legacy flat-overview stylesheet is still active.');

expect(
  mapSource.includes('https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'),
  'Replacement map does not use the worldwide topographic tile service.'
);
expect(!mapSource.includes('tiles.openfreemap.org'), 'Generic OpenFreeMap style is still active.');
expect(mapSource.includes("type: 'raster'"), 'Topographic source is not configured as one raster source.');
expect(mapSource.includes("projection: { type: 'mercator' }"), 'Replacement map does not force flat Mercator projection.');
expect(mapSource.includes("'background-color': '#79BCEC'"), 'Occu-Med water fallback is not locked.');
expect(mapSource.includes("'occumed:source-count': 1"), 'One-source metadata lock is missing.');
expect(mapSource.includes("architecture: 'world-topographic-raster-v3'"), 'Browser readiness contract is missing.');
expect(mapSource.includes("sourceType: 'raster'"), 'Browser readiness contract does not identify the raster source.');

expect(css.includes('#79BCEC'), 'Map canvas fallback is not locked to the Occu-Med water color.');
expect(css.includes('.occumed-atmosphere-bloom'), 'Replacement stylesheet does not explicitly suppress the old atmosphere layer.');

expect(packageJson.scripts?.build === 'npm run check:new-map && vite build', 'Production build still runs the legacy PMTiles/style pipeline.');
expect(packageJson.scripts?.start === 'node server-new-map-v2.mjs', 'Production start command does not use the clean static server.');
expect(packageJson.scripts?.dev === 'vite', 'Development command still runs the legacy asset pipeline.');

for (const [name, content] of [['renderer', mapSource], ['server', server], ['entry', main]]) {
  for (const forbidden of [
    'PMTiles(',
    '/tiles/{z}/{x}/{y}',
    'world-tile-gateway',
    'mergeVectorTiles',
    'overscaleVectorLayer',
    'NAV_DATABASE_URL_',
    'neon-navigation-tile-cache',
    'start-flat-overview',
    'occumed-world-overview.pmtiles',
    'occumed-world-surface.pmtiles'
  ]) {
    expect(!content.includes(forbidden), `${name} still references forbidden legacy path: ${forbidden}`);
  }
}

expect(server.includes("mode: 'world-topographic-raster-v3'"), 'Readiness endpoint does not identify the topographic architecture.');
expect(server.includes("sourceType: 'raster'"), 'Readiness endpoint does not identify the raster source.');
expect(server.includes('runtimeMerging: false'), 'Readiness endpoint does not lock runtime merging off.');
expect(server.includes('regionalRouting: false'), 'Readiness endpoint does not lock regional routing off.');
expect(server.includes('neon: false'), 'Readiness endpoint does not lock Neon off.');

if (failures.length) {
  console.error('Worldwide topographic map architecture validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Worldwide topographic map validated: one raster source, flat Mercator, no PMTiles, no Neon, no routing, and no runtime merging.');
