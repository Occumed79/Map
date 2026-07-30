#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { zxyToTileId } from 'pmtiles';

const VIEWPORT = { width: 1440, height: 1000 };
const TILE_SIZE = 512;
const OVERSCAN_TILES = 3;
const FOUNDATION_WORLD_MAX_ZOOM = 6;
const MOTION_FRAMES = 10;
const BUILD_MOTION_SAMPLES = 120;

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
    result[key.slice(2)] = value;
    index += 1;
  }
  if (!result.plan || !result.output) throw new Error('Required: --plan and --output.');
  return result;
}

function lonToTileX(lon, zoom) {
  return ((lon + 180) / 360) * 2 ** zoom;
}

function latToTileY(lat, zoom) {
  const clipped = Math.min(85.05112878, Math.max(-85.05112878, lat));
  const radians = clipped * Math.PI / 180;
  return ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * 2 ** zoom;
}

function tileKey(tile) {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function cameraTiles({ center, zoom }) {
  const z = Math.max(0, Math.min(16, Math.floor(zoom)));
  const width = 2 ** z;
  const centerX = Math.floor(lonToTileX(center[0], z));
  const centerY = Math.floor(latToTileY(center[1], z));
  const radiusX = Math.ceil(VIEWPORT.width / TILE_SIZE / 2) + OVERSCAN_TILES;
  const radiusY = Math.ceil(VIEWPORT.height / TILE_SIZE / 2) + OVERSCAN_TILES;
  const tiles = [];
  for (let deltaY = -radiusY; deltaY <= radiusY; deltaY += 1) {
    const y = centerY + deltaY;
    if (y < 0 || y >= width) continue;
    for (let deltaX = -radiusX; deltaX <= radiusX; deltaX += 1) {
      const x = ((centerX + deltaX) % width + width) % width;
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

function ease(value) {
  return value < 0.5
    ? 4 * value ** 3
    : 1 - ((-2 * value + 2) ** 3) / 2;
}

function interpolateLongitude(start, end, amount) {
  let delta = end - start;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  let value = start + delta * amount;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

function motionCameras(start, end, count) {
  return Array.from({ length: count }, (_, index) => {
    const amount = count === 1 ? 1 : ease(index / (count - 1));
    return {
      center: [
        interpolateLongitude(start.center[0], end.center[0], amount),
        start.center[1] + (end.center[1] - start.center[1]) * amount
      ],
      zoom: start.zoom + (end.zoom - start.zoom) * amount
    };
  });
}

function prefixContains(prefix, tile) {
  if (prefix.z > tile.z) return false;
  const divisor = 2 ** (tile.z - prefix.z);
  return (
    Math.floor(tile.x / divisor) === prefix.x &&
    Math.floor(tile.y / divisor) === prefix.y
  );
}

function tileBounds(tile) {
  const width = 2 ** tile.z;
  const west = (tile.x / width) * 360 - 180;
  const east = ((tile.x + 1) / width) * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * tile.y) / width))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 1)) / width))) * 180 / Math.PI;
  return [west, south, east, north];
}

function splitAntimeridianBounds(bounds) {
  const [west, south, east, north] = bounds;
  return west <= east
    ? [[west, south, east, north]]
    : [[west, south, 180, north], [-180, south, east, north]];
}

function boundsIntersect(left, right) {
  return !(
    left[2] <= right[0] ||
    left[0] >= right[2] ||
    left[3] <= right[1] ||
    left[1] >= right[3]
  );
}

function candidateIntersectsTile(candidate, tile) {
  const target = tileBounds(tile);
  return splitAntimeridianBounds(candidate.bounds).some((part) =>
    boundsIntersect(part, target)
  );
}

function regionalOwnerForTile(plan, tile) {
  const matches = plan.owners.filter((owner) => prefixContains(owner.prefix, tile));
  if (matches.length > 1) {
    throw new Error(`Expected at most one regional owner for tile ${tileKey(tile)}; found ${matches.length}.`);
  }
  return matches[0] || null;
}

function sortedTiles(map) {
  return [...map.values()].sort((left, right) =>
    zxyToTileId(left.z, left.x, left.y) - zxyToTileId(right.z, right.x, right.y)
  );
}

const options = parseArguments(process.argv.slice(2));
const plan = JSON.parse(await fs.readFile(path.resolve(options.plan), 'utf8'));
const global = { center: [-20, 18], zoom: 2.2 };
const fresnoStreet = { center: [-119.7871, 36.7378], zoom: 16 };
const fresnoGlobal = { center: fresnoStreet.center, zoom: global.zoom };
const antimeridianEast = { center: [179.65, 8], zoom: 8 };
const antimeridianWest = { center: [-179.65, 8], zoom: 8 };
const staticViews = [
  { name: 'global', ...global },
  { name: 'north-america', center: [-100, 40], zoom: 4 },
  { name: 'south-america', center: [-60, -15], zoom: 4 },
  { name: 'europe', center: [12, 50], zoom: 5 },
  { name: 'pacific', center: [155, 0], zoom: 5 },
  { name: 'antimeridian', center: [179.5, 8], zoom: 6 },
  { name: 'fresno-regional', center: fresnoStreet.center, zoom: 8 },
  { name: 'fresno-city', center: fresnoStreet.center, zoom: 12 },
  { name: 'fresno-street', ...fresnoStreet }
];
const motions = [
  { name: 'global-to-street', start: fresnoGlobal, end: fresnoStreet },
  { name: 'street-to-global', start: fresnoStreet, end: fresnoGlobal },
  { name: 'antimeridian-crossing', start: antimeridianEast, end: antimeridianWest }
];
const validationFrames = motions.flatMap((motion) =>
  motionCameras(motion.start, motion.end, MOTION_FRAMES)
    .map((camera, index) => ({ motion: motion.name, index, ...camera }))
);
const buildCameras = [
  ...staticViews,
  ...validationFrames,
  ...motions.flatMap((motion) =>
    motionCameras(motion.start, motion.end, BUILD_MOTION_SAMPLES)
  )
];

const ownerById = new Map();
for (const camera of buildCameras) {
  for (const tile of cameraTiles(camera)) {
    if (tile.z <= FOUNDATION_WORLD_MAX_ZOOM) continue;
    const owner = regionalOwnerForTile(plan, tile);
    if (owner) ownerById.set(owner.id, owner);
  }
}
if (!ownerById.size) throw new Error('Representative target did not touch any high-zoom regional owners.');

const targetMaps = Object.fromEntries([
  ['foundation', new Map()],
  ...[...ownerById].map(([id]) => [id, new Map()])
]);

for (let z = 0; z <= FOUNDATION_WORLD_MAX_ZOOM; z += 1) {
  const width = 2 ** z;
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tile = { z, x, y };
      targetMaps.foundation.set(tileKey(tile), tile);
    }
  }
}
for (const camera of buildCameras) {
  for (const tile of cameraTiles(camera)) {
    if (tile.z <= FOUNDATION_WORLD_MAX_ZOOM) {
      targetMaps.foundation.set(tileKey(tile), tile);
      continue;
    }
    const owner = regionalOwnerForTile(plan, tile);
    const target = owner ? targetMaps[owner.id] : targetMaps.foundation;
    target.set(tileKey(tile), tile);
  }
}

const document = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  viewport: VIEWPORT,
  staticViews,
  validationFrames,
  selectedOwners: [...ownerById.values()].map((owner) => ({
    ...owner,
    requiredCandidates: owner.candidates.filter((candidate) =>
      [...targetMaps[owner.id].values()].some((tile) =>
        candidateIntersectsTile(candidate, tile)
      )
    )
  })),
  targets: Object.fromEntries(
    Object.entries(targetMaps).map(([name, tiles]) => [name, sortedTiles(tiles)])
  )
};
document.totalAddressedTiles = Object.values(document.targets)
  .reduce((sum, targets) => sum + targets.length, 0);

const outputPath = path.resolve(options.output);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `Generated ${document.totalAddressedTiles} exact representative tile targets across ` +
  `${Object.keys(document.targets).length} non-overlapping owners.`
);
