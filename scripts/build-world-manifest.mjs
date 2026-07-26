#!/usr/bin/env node

import fs from 'node:fs/promises';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--plan') options.plan = argv[++index];
    else if (key === '--assets') options.assets = argv[++index];
    else if (key === '--repository') options.repository = argv[++index];
    else if (key === '--tag') options.tag = argv[++index];
    else if (key === '--output') options.output = argv[++index];
  }
  for (const required of ['plan', 'assets', 'repository', 'tag', 'output']) {
    if (!options[required]) throw new Error(`Missing --${required}.`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const [plan, assetsPayload] = await Promise.all([
  fs.readFile(options.plan, 'utf8').then(JSON.parse),
  fs.readFile(options.assets, 'utf8').then(JSON.parse)
]);

const assetNames = new Set((assetsPayload.assets || []).map((asset) => asset.name));
const planned = plan.include || [];
const available = planned.filter((region) => assetNames.has(region.asset_name));
const missing = planned.filter((region) => !assetNames.has(region.asset_name));
const releaseBase = `https://github.com/${options.repository}/releases/download/${options.tag}`;

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  releaseTag: options.tag,
  sourceSchema: 'planetiler/occumed-basemap.yml',
  switchZoom: 6,
  attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
  archiveTransport: 'same-origin-release-proxy',
  archiveProxyTemplate: '__OCCUMED_PUBLIC_ORIGIN__/world-tiles/{asset}',
  releaseBase,
  regions: available.map((region) => ({
    id: region.id,
    slug: region.slug,
    name: region.name,
    continent: region.continent,
    bounds: [region.west, region.south, region.east, region.north],
    asset: region.asset_name,
    url: `__OCCUMED_PUBLIC_ORIGIN__/world-tiles/${region.asset_name}`,
    minzoom: 6,
    maxzoom: 16
  })),
  plannedRegionCount: planned.length,
  availableRegionCount: available.length,
  missingRegionCount: missing.length,
  missingRegions: missing.map((region) => region.id)
};

await fs.writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Published manifest coverage for ${available.length}/${planned.length} world shards.`);
if (missing.length) console.log(`Missing shards: ${missing.map((region) => region.id).join(', ')}`);
