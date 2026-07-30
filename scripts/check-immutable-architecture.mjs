import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeImmutableArtifactVersion,
  validateImmutableManifest
} from '../src/server/immutable-world-tileset.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (filename) => fs.readFile(path.join(root, filename), 'utf8');
const [
  server,
  browser,
  styleBuilder,
  normalizer,
  packageText
] = await Promise.all([
  read('server.mjs'),
  read('src/occumed-map.js'),
  read('scripts/build-runtime-style.mjs'),
  read('scripts/offline-tileset/mvt-normalizer.mjs'),
  read('package.json')
]);

for (const forbidden of [
  'neon-navigation-cache',
  'world-tile-gateway',
  'mergeVectorTiles',
  'world-routing',
  'overscale-vector-tile'
]) {
  assert(
    !server.includes(forbidden),
    `Production server still references forbidden runtime module or operation: ${forbidden}`
  );
}
assert(
  server.includes("from './src/server/immutable-world-tileset.js'"),
  'Production server does not use the immutable PMTiles store.'
);
assert(
  !server.includes('validateVectorTilePayload'),
  'Production server still decodes or validates geometry instead of returning prebuilt bytes.'
);
assert(
  server.includes("'Content-Encoding': resolved.contentEncoding"),
  'Production server does not preserve the stored PMTiles tile compression.'
);

for (const forbidden of [
  'installContinuousTileRetention',
  '_updateRetainedTiles',
  'maxTileCacheZoomLevels'
]) {
  assert(!browser.includes(forbidden), `Browser still stretches or pins parent/child tiles: ${forbidden}`);
}
assert(
  browser.includes('tileManager.constructor.maxUnderzooming = 0') &&
  browser.includes('tileManager.constructor.maxOverzooming = 0'),
  'Browser does not explicitly disable MapLibre parent/child fallback depths.'
);
assert(
  browser.includes('cancelPendingTileRequestsWhileZooming: true'),
  'Browser must use MapLibre normal request cancellation without a retained-tile patch.'
);

assert(!styleBuilder.includes('occumed-terrain'), 'Style builder still creates a second terrain source.');
assert(!styleBuilder.includes('raster-dem'), 'Style builder still creates a raster DEM source.');
assert(
  styleBuilder.includes("reason: 'one-source immutable architecture has no external terrain source'"),
  'Style builder does not document why exported hillshade layers are excluded.'
);

for (const authority of [
  "land: 'world-surface'",
  "depth: 'world-surface'",
  "landcover: 'world-overview'",
  "cartography: 'regional-owner'"
]) {
  assert(normalizer.includes(authority), `Offline authority is missing: ${authority}`);
}
assert(
  normalizer.includes('isLargeAxisAlignedRectangle'),
  'Offline normalizer does not reject large tile-shaped surface polygons.'
);
assert(
  normalizer.includes('rejectedMalformed') && normalizer.includes('rejectedOversized'),
  'Offline normalizer does not count malformed and oversized feature rejection.'
);

const packageJson = JSON.parse(packageText);
assert.equal(packageJson.scripts.start, 'node server.mjs', 'Production start command bypasses the immutable server.');
assert(
  packageJson.scripts['check:runtime'].includes('check-immutable-architecture.mjs'),
  'Runtime validation does not include the immutable architecture lock.'
);

function fixtureManifest(overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    generatedAt: '2000-01-01T00:00:00.000Z',
    planVersion: 'a'.repeat(64),
    browserSourceId: 'occumed-open',
    minZoom: 0,
    maxZoom: 16,
    complete: false,
    validationFixture: true,
    logicalOwnerCount: 1,
    plannedOwnerCount: 2,
    builtOwnerCount: 1,
    defaultOwner: 'foundation',
    totalBytes: 508,
    authorities: {
      land: 'world-surface',
      depth: 'world-surface',
      landcover: 'world-overview',
      cartography: 'regional-owner'
    },
    runtimePolicy: {
      neonTileCache: false,
      runtimeShardMerge: false,
      runtimeLandcoverSynthesis: false,
      runtimeGeometry: false,
      parentChildStretching: false
    },
    foundation: {
      id: 'foundation',
      file: 'foundation.pmtiles',
      bytes: 254,
      sha256: 'b'.repeat(64),
      maxZoom: 6
    },
    owners: [{
      id: 'z6-10-24',
      prefix: { z: 6, x: 10, y: 24 },
      file: 'owners/z6-10-24.pmtiles',
      bytes: 254,
      sha256: 'c'.repeat(64)
    }],
    ...overrides
  };
  manifest.artifactVersion = computeImmutableArtifactVersion(manifest);
  return manifest;
}

const partial = fixtureManifest();
assert.throws(
  () => validateImmutableManifest(partial),
  /incomplete/,
  'Production accepted a partial validation fixture without an explicit override.'
);
assert.doesNotThrow(
  () => validateImmutableManifest(partial, { allowPartial: true }),
  'The explicit validation-fixture override did not work.'
);

const overlapping = fixtureManifest({
  plannedOwnerCount: 2,
  builtOwnerCount: 2,
  complete: true,
  validationFixture: false,
  owners: [
    partial.owners[0],
    {
      id: 'z7-20-48',
      prefix: { z: 7, x: 20, y: 48 },
      file: 'owners/z7-20-48.pmtiles',
      bytes: 254,
      sha256: 'd'.repeat(64)
    }
  ]
});
overlapping.artifactVersion = computeImmutableArtifactVersion(overlapping);
assert.throws(
  () => validateImmutableManifest(overlapping),
  /Overlapping immutable owner prefixes/,
  'Manifest accepted overlapping prebuilt owners.'
);

const splitAncestor = fixtureManifest({
  plannedOwnerCount: 1,
  owners: [{
    id: 'z8-40-96',
    prefix: { z: 8, x: 40, y: 96 },
    exactTiles: [{ z: 7, x: 20, y: 48 }],
    file: 'owners/z8-40-96.pmtiles',
    bytes: 254,
    sha256: 'd'.repeat(64)
  }]
});
splitAncestor.artifactVersion = computeImmutableArtifactVersion(splitAncestor);
assert.doesNotThrow(
  () => validateImmutableManifest(splitAncestor, { allowPartial: true }),
  'A deterministic split-prefix ancestor assignment was rejected.'
);

const duplicateExact = fixtureManifest({
  plannedOwnerCount: 2,
  builtOwnerCount: 2,
  complete: true,
  validationFixture: false,
  owners: [
    splitAncestor.owners[0],
    {
      id: 'z8-41-96',
      prefix: { z: 8, x: 41, y: 96 },
      exactTiles: [{ z: 7, x: 20, y: 48 }],
      file: 'owners/z8-41-96.pmtiles',
      bytes: 254,
      sha256: 'e'.repeat(64)
    }
  ]
});
duplicateExact.artifactVersion = computeImmutableArtifactVersion(duplicateExact);
assert.throws(
  () => validateImmutableManifest(duplicateExact),
  /assigned to both/,
  'Manifest accepted two owners for one exact split-prefix ancestor tile.'
);

const regenerated = fixtureManifest({ generatedAt: '2030-01-01T00:00:00.000Z' });
assert.equal(
  partial.artifactVersion,
  regenerated.artifactVersion,
  'Artifact identity changes with a non-semantic generation timestamp.'
);

console.log(
  'Immutable architecture locked: one source, prebuilt PMTiles reads only, deterministic identity, ' +
  'fail-closed completeness, exact split-ancestor ownership, non-overlapping owners, and no ' +
  'runtime merge/synthesis/stretching.'
);
