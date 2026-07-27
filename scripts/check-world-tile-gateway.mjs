import fs from 'node:fs/promises';
import path from 'node:path';
import vtpbf from 'vt-pbf';
import {
  inspectVectorTile,
  mergeVectorTiles,
  overscaleVectorLayer
} from '../src/server/mvt.js';
import {
  normalizeTileCoordinates,
  WorldTileRoutingIndex
} from '../src/server/world-tile-routing.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

function tile(layers) {
  return Buffer.from(vtpbf.fromGeojsonVt(layers));
}

const westRoad = tile({
  transportation: {
    features: [
      {
        id: 42,
        type: 2,
        geometry: [[[0, 100], [2048, 100]]],
        tags: { class: 'motorway', name: 'Continuous Road' }
      }
    ]
  }
});
const eastRoad = tile({
  transportation: {
    features: [
      {
        id: 42,
        type: 2,
        geometry: [[[0, 100], [2048, 100], [4096, 100]]],
        tags: { class: 'motorway', name: 'Continuous Road' }
      },
      {
        id: 99,
        type: 2,
        geometry: [[[100, 200], [300, 300]]],
        tags: { class: 'primary', name: 'Boundary Road' }
      }
    ]
  }
});

const mergedRoads = inspectVectorTile(mergeVectorTiles([westRoad, eastRoad]));
expect(mergedRoads.transportation?.featureCount === 2, 'Duplicate road IDs were not merged.');
expect(
  JSON.stringify(mergedRoads.transportation?.ids) === JSON.stringify([42, 99]),
  'Merged feature IDs are not deterministic.'
);
expect(
  mergedRoads.transportation?.pointCounts?.[0] === 3,
  'Complementary or contained road geometry was lost or duplicated at a shard boundary.'
);

const surface = tile({
  land: {
    features: [
      {
        id: 1,
        type: 3,
        geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]],
        tags: {}
      }
    ]
  },
  landcover: {
    features: [
      {
        id: 3,
        type: 3,
        geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]],
        tags: { class: 'grass' }
      }
    ]
  },
  depth: {
    features: [
      {
        id: 2,
        type: 3,
        geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]],
        tags: { min_depth: 7000 }
      }
    ]
  }
});
const overscaled = inspectVectorTile(overscaleVectorLayer(surface, {
  layerName: 'land',
  sourceZoom: 10,
  targetZoom: 16,
  targetX: 32768,
  targetY: 32768
}));
expect(overscaled.land?.featureCount === 1, 'The worldwide land surface cannot overscale through max zoom.');
const physicalSurface = inspectVectorTile(
  mergeVectorTiles([surface], { includeLayers: ['land', 'landcover', 'depth'] })
);
expect(physicalSurface.land?.featureCount === 1, 'The physical surface lost its land layer.');
expect(physicalSurface.landcover?.featureCount === 1, 'The physical surface lost generalized landcover.');
expect(physicalSurface.depth?.featureCount === 1, 'The physical surface lost its bathymetry layer.');

const regions = [
  {
    id: 'west',
    asset: 'occumed-west.pmtiles',
    bounds: [-10, -10, 1, 10]
  },
  {
    id: 'east',
    asset: 'occumed-east.pmtiles',
    bounds: [0, -10, 10, 10]
  },
  {
    id: 'antimeridian',
    asset: 'occumed-antimeridian.pmtiles',
    bounds: [170, -20, -170, 20]
  }
];
const routing = new WorldTileRoutingIndex(regions, { routingZoom: 6 });
const boundaryCandidates = routing.regionsForTile(6, 32, 31).map((region) => region.id);
expect(boundaryCandidates.includes('west'), 'The first shard intersecting a boundary tile is missing.');
expect(boundaryCandidates.includes('east'), 'A shard intersecting a boundary tile is missing.');
expect(
  routing.regionsForTile(6, 63, 31).some((region) => region.id === 'antimeridian'),
  'The eastern antimeridian shard segment is missing.'
);
expect(
  routing.regionsForTile(6, 0, 31).some((region) => region.id === 'antimeridian'),
  'The western antimeridian shard segment is missing.'
);

expect(normalizeTileCoordinates(0, 0, 0), 'The globe tile coordinate was rejected.');
expect(!normalizeTileCoordinates(6, 64, 0), 'An out-of-range tile coordinate was accepted.');
expect(!normalizeTileCoordinates(17, 0, 0), 'A tile beyond the storage max zoom was accepted.');

const [runtime, helper, server, gateway, manifestBuilder] = await Promise.all([
  fs.readFile(path.join(root, 'public/style/occumed-open.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'src/occumed-map.js'), 'utf8'),
  fs.readFile(path.join(root, 'server.mjs'), 'utf8'),
  fs.readFile(path.join(root, 'src/server/world-tile-gateway.js'), 'utf8'),
  fs.readFile(path.join(root, 'scripts/build-world-manifest.mjs'), 'utf8')
]);

const vectorSources = Object.entries(runtime.sources || {})
  .filter(([, source]) => source.type === 'vector');
expect(vectorSources.length === 1, `Expected one vector source; found ${vectorSources.length}.`);
expect(vectorSources[0]?.[0] === 'occumed-open', 'The permanent vector source ID changed.');
expect(
  JSON.stringify(vectorSources[0]?.[1]?.tiles) ===
    JSON.stringify(['__OCCUMED_PUBLIC_ORIGIN__/tiles/{z}/{x}/{y}.pbf']),
  'The vector source does not use the one permanent worldwide Z/X/Y endpoint.'
);
expect(!vectorSources[0]?.[1]?.url, 'The vector source can still be replaced through a TileJSON URL.');
expect(!JSON.stringify(runtime).toLowerCase().includes('openfreemap'), 'OpenFreeMap is still active in the runtime style.');
expect(!JSON.stringify(runtime).includes('pmtiles://'), 'A storage archive is still exposed in the runtime style.');
expect(!helper.includes('setUrl('), 'The browser helper can still replace the vector source URL.');
expect(!helper.includes("addProtocol('pmtiles'"), 'The browser still reads PMTiles storage shards directly.');
expect(!helper.includes('WorldPmtilesRouter'), 'The browser still installs the removed regional router.');
expect(helper.includes('fadeDuration: 0'), 'Tile fading can still expose stale cartography during zoom.');
expect(server.includes('/tiles\\/(\\d+)\\/(\\d+)\\/(\\d+)\\.pbf'), 'The server does not expose the permanent worldwide tile route.');
expect(server.includes("'world-virtual-manifest.json'"), 'The gateway does not use the isolated server-only manifest.');
expect(!server.includes('/world-tiles/'), 'The server still exposes regional storage URLs to the browser.');
expect(gateway.includes('mergeVectorTiles'), 'The server gateway cannot merge boundary tiles.');
expect(gateway.includes('MemoryTileCache'), 'The server gateway does not cache resolved virtual tiles.');
expect(
  gateway.includes('return payload || EMPTY_MVT'),
  'A missing overview enrichment can still blank the independently resolved physical surface.'
);
expect(
  !gateway.includes('Worldwide overview is missing tile'),
  'A missing overview enrichment can still reject the complete worldwide tile.'
);
expect(
  gateway.includes("includeLayers: ['land', 'landcover', 'depth']"),
  'The gateway does not expose land, landcover, and bathymetry as one continuous physical surface.'
);
expect(manifestBuilder.includes('version: 2'), 'The server-only routing manifest is not version 2.');
expect(
  manifestBuilder.includes("surfaceLayers: ['land', 'landcover', 'depth']"),
  'The routing manifest does not declare the complete physical surface schema.'
);
expect(!manifestBuilder.includes('switchZoom'), 'The obsolete browser switch zoom remains in the manifest.');

try {
  await fs.access(path.join(root, 'src/world-pmtiles-router.js'));
  expect(false, 'The browser-side regional PMTiles router still exists.');
} catch {
  // Expected: the obsolete router is gone.
}

if (failures.length) {
  console.error('Virtual worldwide tile gateway validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Virtual worldwide tileset validated: one permanent source, boundary merging, antimeridian routing, land, landcover, and bathymetry continuity, surface overscaling, caching, and no browser-visible shards.');
