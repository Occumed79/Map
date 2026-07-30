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

expect(main.includes("./new-map-v2.js"), 'Application entry point does not use the clean map v2 renderer.');
expect(main.includes("./new-map-v2.css"), 'Application entry point does not use the clean map v2 stylesheet.');
expect(!main.includes('occumed-map.js'), 'Legacy PMTiles-aware map renderer is still active.');
expect(!main.includes('flat-overview.css'), 'Legacy flat-overview stylesheet is still active.');

expect(mapSource.includes("https://tiles.openfreemap.org/styles/liberty"), 'Clean map does not use the selected complete worldwide style.');
expect(mapSource.includes('vectorSources.length !== 1'), 'Clean map does not enforce exactly one vector source.');
expect(mapSource.includes("style.projection = { type: 'globe' }"), 'Clean map does not force globe projection.');
expect(mapSource.includes("'atmosphere-blend'"), 'Globe atmosphere configuration is missing.');
expect(mapSource.includes("space: '#181A1D'"), 'Dark-space color is not locked.');
expect(mapSource.includes("atmosphere: '#B8E6FF'"), 'Atmosphere glow color is not locked.');
expect(mapSource.includes("halo: '#F5FDFF'"), 'Horizon color is not locked.');
expect(mapSource.includes("water: '#79BCEC'"), 'Occu-Med water color is not locked.');
expect(mapSource.includes("park: '#A5CC8E'"), 'Occu-Med park color is not locked.');
expect(mapSource.includes("road: '#F2F2F2'"), 'Occu-Med road color is not locked.');
expect(mapSource.includes("boundary: '#A65966'"), 'Occu-Med boundary color is not locked.');
expect(mapSource.includes("'occumed:source-count': 1"), 'One-source metadata lock is missing.');
expect(mapSource.includes("architecture: 'clean-worldwide-globe-v2'"), 'Browser readiness contract is missing.');
expect(mapSource.includes('renderedFeatureCount'), 'Browser readiness contract does not record rendered features.');
expect(mapSource.includes('renderedSourceLayers'), 'Browser readiness contract does not record rendered source layers.');

expect(css.includes('#181A1D'), 'Map canvas is not locked to the dark-space reference color.');
expect(!css.includes('display: none !important'), 'Clean globe stylesheet still suppresses globe or atmosphere rendering.');

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

expect(server.includes("mode: 'clean-worldwide-globe-v2'"), 'Readiness endpoint does not identify the new globe architecture.');
expect(server.includes("projection: 'globe'"), 'Readiness endpoint does not lock globe projection.');
expect(server.includes('atmosphere: true'), 'Readiness endpoint does not lock atmosphere on.');
expect(server.includes('runtimeMerging: false'), 'Readiness endpoint does not lock runtime merging off.');
expect(server.includes('regionalRouting: false'), 'Readiness endpoint does not lock regional routing off.');
expect(server.includes('neon: false'), 'Readiness endpoint does not lock Neon off.');

if (failures.length) {
  console.error('Clean worldwide globe v2 architecture validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Clean worldwide globe v2 validated: one complete vector source, reference palette and atmosphere, no PMTiles, no Neon, no routing, and no runtime merging.');
