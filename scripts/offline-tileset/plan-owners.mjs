#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_RELEASE = 'occumed-world-v1';
const DEFAULT_ROUTING_ZOOM = 6;
const DEFAULT_MAX_PREFIX_ZOOM = 8;
const DEFAULT_MAX_CANDIDATE_BYTES = 2 * 1024 * 1024 * 1024;

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
  return result;
}

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat, zoom) {
  const clipped = Math.min(85.05112878, Math.max(-85.05112878, lat));
  const radians = clipped * Math.PI / 180;
  return Math.floor(
    ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * 2 ** zoom
  );
}

function tileBounds(z, x, y) {
  const width = 2 ** z;
  const west = (x / width) * 360 - 180;
  const east = ((x + 1) / width) * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / width))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / width))) * 180 / Math.PI;
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

function regionIntersectsTile(region, tile) {
  const bounds = tileBounds(tile.z, tile.x, tile.y);
  return splitAntimeridianBounds(region.bounds).some((part) => boundsIntersect(part, bounds));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => key !== 'generatedAt')
      .map((key) => [key, canonical(value[key])])
  );
}

function planHash(plan) {
  return createHash('sha256')
    .update(`${JSON.stringify(canonical(plan))}\n`)
    .digest('hex');
}

async function fetchJson(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Occu-Med-Map/offline-owner-plan' }
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

function splitOwner(prefix, candidates, options, output) {
  const candidateBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  if (
    candidateBytes <= options.maxCandidateBytes ||
    prefix.z >= options.maxPrefixZoom
  ) {
    const owner = {
      id: `z${prefix.z}-${prefix.x}-${prefix.y}`,
      prefix,
      exactTiles: [],
      candidateBytes,
      candidates: candidates
        .map((candidate) => ({
          id: candidate.id,
          asset: candidate.asset,
          bounds: candidate.bounds,
          bytes: candidate.bytes,
          sha256: candidate.sha256,
          url: candidate.url
        }))
        .sort((left, right) => left.asset.localeCompare(right.asset))
    };
    output.push(owner);
    return owner;
  }

  let deterministicAncestorOwner = null;
  for (let deltaY = 0; deltaY < 2; deltaY += 1) {
    for (let deltaX = 0; deltaX < 2; deltaX += 1) {
      const child = {
        z: prefix.z + 1,
        x: prefix.x * 2 + deltaX,
        y: prefix.y * 2 + deltaY
      };
      const childCandidates = candidates.filter((candidate) =>
        regionIntersectsTile(candidate, child)
      );
      if (childCandidates.length) {
        const childOwner = splitOwner(child, childCandidates, options, output);
        deterministicAncestorOwner ||= childOwner;
      }
    }
  }
  if (!deterministicAncestorOwner) {
    throw new Error(`Split owner ${prefix.z}/${prefix.x}/${prefix.y} has no descendants.`);
  }
  if (prefix.z > options.routingZoom) {
    deterministicAncestorOwner.exactTiles.push(prefix);
  }
  return deterministicAncestorOwner;
}

const options = parseArguments(process.argv.slice(2));
const repository = options.repository || 'Occumed79/Map';
const tag = options.tag || DEFAULT_RELEASE;
const outputPath = path.resolve(
  options.output || path.join(root, 'config/immutable-owner-plan.json')
);
const routingZoom = Number(options['routing-zoom'] || DEFAULT_ROUTING_ZOOM);
const maxPrefixZoom = Number(options['max-prefix-zoom'] || DEFAULT_MAX_PREFIX_ZOOM);
const maxCandidateBytes = Number(
  options['max-candidate-bytes'] || DEFAULT_MAX_CANDIDATE_BYTES
);

const releaseApi = `https://api.github.com/repos/${repository}/releases/tags/${tag}`;
const release = await fetchJson(releaseApi);
const byName = new Map(
  (release.assets || []).map((asset) => [
    asset.name,
    {
      asset: asset.name,
      bytes: Number(asset.size),
      sha256: String(asset.digest || '').replace(/^sha256:/, ''),
      url: asset.browser_download_url
    }
  ])
);
const manifestAsset = byName.get('world-virtual-manifest.json');
if (!manifestAsset) throw new Error('Published world-virtual-manifest.json is missing.');
const published = await fetchJson(manifestAsset.url);
const overview = byName.get(published.virtualTiles?.overviewAsset);
const surface = byName.get(published.virtualTiles?.surfaceAsset);
if (!overview || !surface) throw new Error('Published overview or surface archive is missing.');

const regions = (published.regions || []).map((region) => {
  const asset = byName.get(region.asset);
  if (!asset || !asset.sha256 || asset.sha256.length !== 64) {
    throw new Error(`Release asset lock is incomplete for ${region.asset}.`);
  }
  return {
    id: region.id,
    bounds: region.bounds.map(Number),
    ...asset
  };
});

const owners = [];
let logicalOwnerCount = 0;
const width = 2 ** routingZoom;
for (let y = 0; y < width; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const prefix = { z: routingZoom, x, y };
    const candidates = regions.filter((region) => regionIntersectsTile(region, prefix));
    if (candidates.length) {
      logicalOwnerCount += 1;
      splitOwner(prefix, candidates, {
        maxCandidateBytes,
        maxPrefixZoom,
        routingZoom
      }, owners);
    }
  }
}
owners.sort((left, right) =>
  left.prefix.z - right.prefix.z ||
  left.prefix.x - right.prefix.x ||
  left.prefix.y - right.prefix.y
);

const plan = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository,
  releaseTag: tag,
  routingZoom,
  maxPrefixZoom,
  maxCandidateBytes,
  authorities: {
    land: 'world-surface',
    depth: 'world-surface',
    landcover: 'world-overview',
    cartography: 'regional-owner'
  },
  inputs: {
    overview,
    surface,
    regionCount: regions.length,
    regionalBytes: regions.reduce((sum, region) => sum + region.bytes, 0)
  },
  owners,
  logicalOwnerCount,
  plannedOwnerCount: owners.length
};
plan.planVersion = planHash(plan);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log(
  `Planned ${owners.length} deterministic physical owners across ${logicalOwnerCount} logical z${routingZoom} cells ` +
  `from ${regions.length} SHA-locked regional inputs ` +
  `(${plan.inputs.regionalBytes} bytes); plan ${plan.planVersion}.`
);
