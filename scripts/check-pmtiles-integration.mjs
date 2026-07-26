import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [
  pkg,
  helper,
  router,
  sourcePass,
  sourceProfile,
  profilePreparer,
  buildScript,
  planner,
  manifestBuilder,
  server,
  workflow,
  action,
  capture,
  readme
] = await Promise.all([
  fs.readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8'),
  fs.readFile(path.join(root, 'src/world-pmtiles-router.js'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/use-custom-pmtiles-source.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'planetiler/occumed-basemap.yml'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/prepare-planetiler-profile.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'planetiler/build-region.sh'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/plan-world-shards.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-manifest.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'server.mjs'), 'utf8'),
  fs.readFile(path.join(root, '.github/workflows/build-world-pmtiles.yml'), 'utf8'),
  fs.readFile(path.join(root, '.github/actions/build-pmtiles-shard/action.yml'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/capture-pmtiles-preview.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'README.md'), 'utf8')
]);

const failures = [];
const fail = (message) => failures.push(message);

if (pkg.dependencies?.pmtiles !== '4.4.1') fail('The PMTiles browser dependency is missing or unpinned.');
if (pkg.scripts?.['tiles:plan-world'] !== 'node scripts/plan-world-shards.mjs --scope all') {
  fail('The worldwide shard planning command is missing.');
}
if (!helper.includes("import { Protocol } from 'pmtiles';")) fail('The PMTiles protocol import is missing.');
if (!helper.includes("maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile)")) fail('MapLibre does not register the PMTiles protocol.');
if (!helper.includes("source.url.replaceAll('__OCCUMED_PUBLIC_ORIGIN__', styleOrigin)")) fail('PMTiles source URLs are not resolved against the deployed origin.');
if (!helper.includes('installWorldPmtilesRouter')) fail('The shared map helper does not install worldwide PMTiles routing.');
if (!helper.includes("style.metadata?.['occumed:world-manifest-url']")) fail('The shared map helper does not read the worldwide manifest URL.');
if (!readme.includes('createOccumedMap')) fail('Reusable integration docs bypass the PMTiles-aware map helper.');
if (!readme.includes('Directly fetching the style')) fail('Reusable integration docs do not reject unsupported raw-style construction.');

if (!router.includes('source.setUrl(nextUrl)')) fail('The worldwide router cannot swap regional PMTiles archives.');
if (!router.includes('map.getZoom() >= switchZoom')) fail('The worldwide router does not preserve the low-zoom global overview.');
if (!router.includes('occumedworldsourcechange')) fail('Worldwide source changes are not observable by consuming apps.');
if (!router.includes('longitude >= west || longitude <= east')) fail('The worldwide router does not support antimeridian bounds.');

if (!sourcePass.includes('OCCUMED_PMTILES_URL')) fail('The runtime style cannot be pointed at a custom PMTiles archive.');
if (!sourcePass.includes('OCCUMED_WORLD_MANIFEST_URL')) fail('The runtime style cannot override the worldwide PMTiles manifest.');
if (!sourcePass.includes("'__OCCUMED_PUBLIC_ORIGIN__/world-manifest.json'")) fail('The deployed worldwide manifest endpoint is not enabled by default.');
if (!sourcePass.includes("'occumed:vector-source-mode': 'world-sharded-planetiler-pmtiles'")) fail('Worldwide PMTiles source metadata is missing.');

if (!buildScript.includes('ghcr.io/onthegomap/planetiler:0.10.2')) fail('Planetiler is not pinned to the published 0.10.2 Docker image.');
if (!buildScript.includes('prepare-planetiler-profile.mjs')) fail('PMTiles builds do not generate the corrected Planetiler profile.');
if (!buildScript.includes('/profile/occumed-basemap.yml')) fail('PMTiles builds do not invoke the generated YAML profile directly.');
if (buildScript.includes('generate-custom') || buildScript.includes('--schema=')) fail('PMTiles builds use unsupported custom-profile wrapper arguments.');
if (!buildScript.includes('--osm-path="$CONTAINER_OSM_PATH"')) fail('PMTiles builds do not use Planetiler\'s supported local OSM path argument.');
if (buildScript.includes('--osm-source-path=')) fail('PMTiles builds still use the unsupported osm-source-path argument.');
if (!buildScript.includes('sha256sum "$OUTPUT_NAME"')) fail('PMTiles checksums are not portable across build paths.');

for (const marker of [
  'version: "0.3.0"',
  'args.area.replace("/", "_")',
  'leisure: [garden, playground, golf_course, pitch]',
  'highway: [unclassified, residential, living_street]',
  'waterway: [river, canal, stream]',
  'name:latin'
]) {
  if (!profilePreparer.includes(marker)) fail(`The generated Planetiler profile correction is missing: ${marker}`);
}

if (!planner.includes('https://download.geofabrik.de/index-v1.json')) fail('The worldwide planner is not sourced from the Geofabrik index.');
if (!planner.includes('downloadableChildren.length > 0')) fail('The worldwide planner is not selecting leaf extracts.');
if (!planner.includes('asset_name: `occumed-${slug}.pmtiles`')) fail('The worldwide planner does not produce deterministic archive names.');
if (!manifestBuilder.includes("archiveTransport: 'same-origin-release-proxy'")) fail('The worldwide manifest does not use the release proxy transport.');
if (!manifestBuilder.includes("url: `__OCCUMED_PUBLIC_ORIGIN__/world-tiles/${region.asset_name}`")) fail('The worldwide manifest does not route archives through the deployed origin.');

if (!server.includes("url.pathname === '/world-manifest.json'")) fail('The server does not proxy the worldwide manifest.');
if (!server.includes('/^\\/world-tiles\\/(occumed-[a-z0-9-]+\\.pmtiles)$/')) fail('The server does not constrain worldwide PMTiles asset names.');
if (!server.includes('Readable.fromWeb(upstream.body)')) fail('The server does not stream release archives.');
if (!server.includes('if (request.headers.range) headers.Range = request.headers.range')) fail('The release proxy does not forward PMTiles byte ranges.');

if (!workflow.includes('Build Worldwide Occu-Med PMTiles')) fail('The worldwide build workflow is missing.');
if (!workflow.includes('WORLD_BUCKETS: 6')) fail('The worldwide workflow is not partitioned into bounded matrices.');
if (!workflow.includes('publish-world-manifest')) fail('The worldwide workflow does not publish a final manifest.');
if (!workflow.includes('Require complete worldwide coverage')) fail('The worldwide workflow does not reject missing regions.');
if (!action.includes('gh release upload')) fail('Worldwide PMTiles shards are not published to GitHub Releases.');
if (!action.includes("--header 'Range: bytes=0-126'")) fail('Published shard byte ranges are not validated.');

for (const requiredLayer of [
  'landcover', 'landuse', 'park', 'water', 'waterway', 'transportation',
  'transportation_name', 'building', 'aeroway', 'aerodrome_label', 'boundary',
  'place', 'poi', 'water_name', 'mountain_peak', 'housenumber'
]) {
  if (!sourceProfile.includes(`- id: ${requiredLayer}`)) {
    fail(`Planetiler source profile is missing layer: ${requiredLayer}`);
  }
}

for (const requiredAttribute of ['class', 'subclass', 'brunnel', 'ramp', 'ref', 'rank', 'admin_level', 'disputed']) {
  if (!sourceProfile.includes(`key: ${requiredAttribute}`)) {
    fail(`Planetiler source profile is missing normalized attribute: ${requiredAttribute}`);
  }
}

if (!capture.includes("url.startsWith('pmtiles://')")) fail('Visual validation does not assert the PMTiles protocol.');
if (!capture.includes('map.areTilesLoaded()')) fail('Visual validation does not require all map tiles to load.');
if (!capture.includes('unexpectedNetworkFailures')) fail('Visual validation does not reject unexpected resource failures.');
if (!capture.includes('expectedArchive')) fail('Visual validation does not assert the expected regional archive.');

if (failures.length) {
  console.error('PMTiles integration validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('PMTiles integration validated: supported Planetiler YAML invocation, corrected schema generation, protocol registration, worldwide routing, release proxying, shard builds, strict visual evidence, and manifest publication are present.');
