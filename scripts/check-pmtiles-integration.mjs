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
  pinnedPlanner,
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
  fs.readFile(path.join(root, 'scripts/plan-world-shards-final.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-manifest.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'server.mjs'), 'utf8'),
  fs.readFile(path.join(root, '.github/workflows/repair-missing-world-pmtiles.yml'), 'utf8'),
  fs.readFile(path.join(root, '.github/actions/build-pmtiles-shard-final/action.yml'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/capture-world-fresno-preview.mjs'), 'utf8'),
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
if (!planner.includes('hasDownloadableDescendant')) fail('The worldwide planner does not reject overlapping parent extracts recursively.');
if (!planner.includes('DIRECT_PBF_LIMIT_BYTES')) fail('The worldwide planner does not identify oversized source extracts.');
if (!planner.includes('splitRegion(region, sourceSizeBytes)')) fail('The worldwide planner cannot subdivide oversized sources.');
if (!planner.includes("extract_bbox: `${roundedWest},${roundedSouth},${roundedEast},${roundedNorth}`")) fail('Bounded subdivision metadata is missing from the worldwide plan.');
if (!planner.includes('coveredWidth > 300')) fail('The worldwide planner does not preserve global versus antimeridian-aware bounds.');
if (!planner.includes('asset_name: `occumed-${slug}.pmtiles`')) fail('The worldwide planner does not produce deterministic archive names.');

if (!pinnedPlanner.includes('canonical-world-plan.json')) fail('The final completion planner is not pinned to the audited canonical inventory.');
if (!pinnedPlanner.includes('forcedSplits')) fail('The final pinned planner does not preserve required oversized-parent replacements.');
if (!pinnedPlanner.includes("antimeridian: true")) fail('The final pinned planner does not preserve the Far Eastern antimeridian split.');
if (!pinnedPlanner.includes('extract_bbox: `${west},${south},${east},${north}`')) fail('The final pinned planner does not emit bounded child coordinates.');
if (!pinnedPlanner.includes('plan.include.sort')) fail('The final pinned plan is not deterministically ordered.');

if (!manifestBuilder.includes("archiveTransport: 'same-origin-release-proxy'")) fail('The worldwide manifest does not use the release proxy transport.');
if (!manifestBuilder.includes("url: `__OCCUMED_PUBLIC_ORIGIN__/world-tiles/${region.asset_name}`")) fail('The worldwide manifest does not route archives through the deployed origin.');

if (!server.includes("url.pathname === '/world-manifest.json'")) fail('The server does not proxy the worldwide manifest.');
if (!server.includes('/^\\/world-tiles\\/(occumed-[a-z0-9-]+\\.pmtiles)$/')) fail('The server does not constrain worldwide PMTiles asset names.');
if (!server.includes('Readable.fromWeb(upstream.body)')) fail('The server does not stream release archives.');
if (!server.includes('if (request.headers.range) headers.Range = request.headers.range')) fail('The release proxy does not forward PMTiles byte ranges.');

if (!workflow.includes('Complete Only Pinned Missing Worldwide PMTiles')) fail('The pinned worldwide completion workflow is missing.');
if (!workflow.includes('node scripts/plan-world-shards-final.mjs')) fail('The completion workflow does not generate the pinned canonical plan.');
if ((workflow.match(/node scripts\/plan-world-shards-final\.mjs/g) || []).length !== 1) fail('The pinned canonical plan must be generated exactly once per completion run.');
if (!workflow.includes('max-parallel: 24')) fail('The missing-only completion matrix does not request bounded concurrency.');
if (!workflow.includes('matrix: ${{ fromJson(needs.plan.outputs.matrix) }}')) fail('The completion workflow does not schedule only the exact missing matrix.');
if (!workflow.includes('extract-bbox: ${{ matrix.extract_bbox }}')) fail('The missing-only matrix does not pass bounded subdivision coordinates to the shard action.');
if (!workflow.includes('uses: ./.github/actions/build-pmtiles-shard-final')) fail('The completion workflow does not use the hardened final shard action.');
if (!workflow.includes('Publish manifest only when pinned plan has zero missing shards')) fail('The completion workflow does not publish the final manifest.');
if (!workflow.includes('test "$missing" = "0"')) fail('The completion workflow does not reject incomplete worldwide coverage.');
if (!workflow.includes('gh release upload "$WORLD_RELEASE_TAG" world-release/world-manifest.json')) fail('The completed manifest is not published to the release.');

if (!action.includes('Reuse existing nonzero release asset')) fail('Repair runs do not reuse nonzero published worldwide archives.');
if (!action.includes('osmium extract --bbox="$EXTRACT_BBOX"')) fail('Oversized-region subdivisions are not extracted before Planetiler runs.');
if (!action.includes("test \"$(head -c 7 \"$output\")\" = 'PMTiles'")) fail('Local shard validation does not assert the PMTiles magic header.');
if (!action.includes('Archive exceeds GitHub Release safe file size')) fail('Shard publication does not reject unsafe oversized release assets.');
if (!action.includes('gh release upload')) fail('Worldwide PMTiles shards are not published to GitHub Releases.');
if (!action.includes('Release asset is still missing after upload')) fail('Shard publication does not verify a nonzero release asset after upload.');

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

if (!capture.includes("fetch(`${origin}/world-manifest.json`")) fail('Final visual validation does not load the completed worldwide manifest through the runtime.');
if (!capture.includes("headers: { Range: 'bytes=0-126' }")) fail('Final visual validation does not verify runtime PMTiles byte-range delivery.');
if (!capture.includes("source.url.includes(`/world-tiles/${expectedAsset}`)")) fail('Final visual validation does not assert the selected worldwide shard.');
if (!capture.includes('map.areTilesLoaded()')) fail('Final visual validation does not require all map tiles to load.');
if (!capture.includes('effectivePixelRatio < 1.9')) fail('Final visual validation does not enforce 2x high-DPI rendering.');
if (!capture.includes('unexpectedNetworkFailures')) fail('Final visual validation does not reject unexpected resource failures.');
if (!capture.includes('missingRegionCount') || !capture.includes('!== 0')) fail('Final visual validation does not reject an incomplete manifest.');

if (failures.length) {
  console.error('PMTiles integration validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('PMTiles integration validated: supported Planetiler YAML invocation, audited pinned planning, antimeridian-safe bounded child shards, missing-only 24-worker completion, hardened release publication, protocol registration, worldwide routing, same-origin range proxying, strict high-DPI Fresno evidence, and zero-missing manifest publication are present.');
