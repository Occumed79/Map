#!/usr/bin/env node

import fs from 'node:fs/promises';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--plan') options.plan = argv[++index];
    else if (key === '--assets') options.assets = argv[++index];
    else if (key === '--asset-pages') options.assets = argv[++index];
    else if (key === '--repository') options.repository = argv[++index];
    else if (key === '--tag') options.tag = argv[++index];
    else if (key === '--output') options.output = argv[++index];
    else if (key === '--overview-asset') options.overviewAsset = argv[++index];
    else if (key === '--surface-asset') options.surfaceAsset = argv[++index];
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

const assets = Array.isArray(assetsPayload)
  ? assetsPayload.flatMap((page) => page || [])
  : assetsPayload.assets || [];
const healthyAssetNames = new Set(
  assets
    .filter((asset) => asset.state === 'uploaded' && Number(asset.size || 0) > 0)
    .map((asset) => asset.name)
);
const planned = plan.include || [];
const available = planned.filter((region) => healthyAssetNames.has(region.asset_name));
const missing = planned.filter((region) => !healthyAssetNames.has(region.asset_name));
const overviewAsset = options.overviewAsset || 'occumed-world-overview.pmtiles';
const surfaceAsset = options.surfaceAsset || 'occumed-world-surface.pmtiles';
const missingVirtualAssets = [overviewAsset, surfaceAsset].filter(
  (asset) => !healthyAssetNames.has(asset)
);

if (missingVirtualAssets.length) {
  throw new Error(
    `Cannot publish the virtual worldwide manifest; missing ${missingVirtualAssets.join(', ')}.`
  );
}

const manifest = {
  version: 2,
  generatedAt: new Date().toISOString(),
  releaseTag: options.tag,
  sourceSchema: 'planetiler/occumed-basemap.yml',
  attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
  archiveTransport: 'server-side-release-storage',
  virtualTiles: {
    endpoint: '/tiles/{z}/{x}/{y}.pbf',
    overviewAsset,
    overviewMaxZoom: 5,
    surfaceAsset,
    surfaceLayer: 'land',
    surfaceLayers: ['land', 'depth'],
    surfaceMaxZoom: 10,
    routingZoom: 6,
    minZoom: 0,
    maxZoom: 16
  },
  regions: available.map((region) => ({
    id: region.id,
    slug: region.slug,
    name: region.name,
    continent: region.continent,
    bounds: [region.west, region.south, region.east, region.north],
    asset: region.asset_name,
    minzoom: 0,
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
