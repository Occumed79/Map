#!/usr/bin/env node

import fs from 'node:fs/promises';

const INDEX_URL = process.env.GEOFABRIK_INDEX_URL || 'https://download.geofabrik.de/index-v1.json';
const INDEX_FILE = process.env.GEOFABRIK_INDEX_FILE || '';
const DEFAULT_BUCKETS = 6;
const DIRECT_PBF_LIMIT_BYTES = Number(process.env.OCCUMED_DIRECT_PBF_LIMIT_BYTES || 850_000_000);
const TARGET_SPLIT_PBF_BYTES = Number(process.env.OCCUMED_TARGET_SPLIT_PBF_BYTES || 300_000_000);
const MAX_SPLIT_CELLS = Number(process.env.OCCUMED_MAX_SPLIT_CELLS || 24);
const SIZE_PROBE_CONCURRENCY = Number(process.env.OCCUMED_SIZE_PROBE_CONCURRENCY || 16);
const SIZE_AWARE = process.env.OCCUMED_WORLD_SIZE_AWARE !== '0';
const rootIds = new Set([
  'africa',
  'antarctica',
  'asia',
  'australia-oceania',
  'central-america',
  'europe',
  'north-america',
  'south-america'
]);

function parseArgs(argv) {
  const options = { scope: 'all', buckets: DEFAULT_BUCKETS, bucket: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--scope') options.scope = argv[++index] || 'all';
    else if (value === '--buckets') options.buckets = Number(argv[++index]);
    else if (value === '--bucket') options.bucket = Number(argv[++index]);
    else if (!value.startsWith('--')) options.scope = value;
  }
  if (!Number.isSafeInteger(options.buckets) || options.buckets < 1 || options.buckets > 32) {
    throw new Error('--buckets must be an integer from 1 to 32.');
  }
  if (
    options.bucket !== null &&
    (!Number.isSafeInteger(options.bucket) || options.bucket < 0 || options.bucket >= options.buckets)
  ) {
    throw new Error('--bucket must be within the configured bucket count.');
  }
  return options;
}

function walkCoordinates(value, visit) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    visit(value[0], value[1]);
    return;
  }
  for (const child of value) walkCoordinates(child, visit);
}

function normalize360(longitude) {
  return ((longitude % 360) + 360) % 360;
}

function signedLongitude(longitude) {
  const normalized = normalize360(longitude);
  return normalized > 180 ? normalized - 360 : normalized;
}

function roundCoordinate(value) {
  return Number(value.toFixed(6));
}

function geometryBounds(geometry) {
  if (!geometry?.coordinates) return null;
  const longitudes = [];
  let south = Infinity;
  let north = -Infinity;
  walkCoordinates(geometry.coordinates, (longitude, latitude) => {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    longitudes.push(normalize360(longitude));
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  });
  if (!longitudes.length || !Number.isFinite(south) || !Number.isFinite(north)) return null;

  longitudes.sort((left, right) => left - right);
  let largestGap = -1;
  let largestGapIndex = 0;
  for (let index = 0; index < longitudes.length; index += 1) {
    const current = longitudes[index];
    const next = index === longitudes.length - 1 ? longitudes[0] + 360 : longitudes[index + 1];
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }

  const coveredWidth = 360 - largestGap;
  if (coveredWidth > 300) {
    return [-180, roundCoordinate(south), 180, roundCoordinate(north)];
  }

  const start = longitudes[(largestGapIndex + 1) % longitudes.length];
  const end = longitudes[largestGapIndex];
  return [
    roundCoordinate(signedLongitude(start)),
    roundCoordinate(south),
    roundCoordinate(signedLongitude(end)),
    roundCoordinate(north)
  ];
}

function slugify(id) {
  return String(id)
    .toLowerCase()
    .replaceAll('/', '--')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{3,}/g, '--')
    .replace(/^-|-$/g, '');
}

function ancestorRoot(id, byId) {
  let current = byId.get(id);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (rootIds.has(current.id)) return current.id;
    current = byId.get(current.parent);
  }
  return null;
}

async function loadIndex() {
  if (INDEX_FILE) return JSON.parse(await fs.readFile(INDEX_FILE, 'utf8'));
  const response = await fetch(INDEX_URL, {
    headers: { 'User-Agent': 'Occu-Med-Map/world-pmtiles-planner' }
  });
  if (!response.ok) throw new Error(`Unable to load Geofabrik index (${response.status}).`);
  return response.json();
}

function buildBasePlan(index, scope) {
  const entries = (index.features || [])
    .map((feature) => {
      const properties = feature.properties || {};
      const id = properties.id;
      const pbfUrl = properties.urls?.pbf;
      if (!id) return null;
      return {
        id,
        parent: properties.parent || null,
        name: properties.name || id,
        pbfUrl: typeof pbfUrl === 'string' ? pbfUrl : null,
        bounds: geometryBounds(feature.geometry)
      };
    })
    .filter(Boolean);

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map();
  for (const entry of entries) {
    if (!entry.parent) continue;
    const list = children.get(entry.parent) || [];
    list.push(entry.id);
    children.set(entry.parent, list);
  }

  const descendantMemo = new Map();
  function hasDownloadableDescendant(id, seen = new Set()) {
    if (descendantMemo.has(id)) return descendantMemo.get(id);
    if (seen.has(id)) return false;
    const nextSeen = new Set(seen).add(id);
    const result = (children.get(id) || []).some((childId) => {
      const child = byId.get(childId);
      return Boolean(child?.pbfUrl || hasDownloadableDescendant(childId, nextSeen));
    });
    descendantMemo.set(id, result);
    return result;
  }

  const selected = [];
  for (const entry of entries) {
    if (!entry.pbfUrl || !entry.bounds) continue;
    const root = ancestorRoot(entry.id, byId) || entry.id;
    if (scope !== 'all' && root !== scope && entry.id !== scope) continue;

    // Select true downloadable leaves, not merely entries without an immediate
    // downloadable child. This removes overlapping parent archives when deeper
    // regional PBFs exist anywhere below them in the Geofabrik hierarchy.
    if (hasDownloadableDescendant(entry.id)) continue;

    const [west, south, east, north] = entry.bounds;
    const slug = slugify(entry.id);
    selected.push({
      id: entry.id,
      slug,
      name: entry.name,
      continent: root,
      pbf_url: entry.pbfUrl,
      extract_bbox: '',
      source_region_id: entry.id,
      source_size_bytes: null,
      west,
      south,
      east,
      north,
      asset_name: `occumed-${slug}.pmtiles`,
      metadata_name: `occumed-${slug}.json`
    });
  }

  selected.sort((left, right) => left.id.localeCompare(right.id));
  return selected;
}

async function fetchRemoteSize(url) {
  const headers = { 'User-Agent': 'Occu-Med-Map/world-pmtiles-planner' };
  for (const method of ['HEAD', 'RANGE']) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        method: method === 'HEAD' ? 'HEAD' : 'GET',
        redirect: 'follow',
        headers: method === 'HEAD' ? headers : { ...headers, Range: 'bytes=0-0' },
        signal: controller.signal
      });
      if (!response.ok && response.status !== 206) continue;
      const contentRange = response.headers.get('content-range');
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) return Number(match[1]);
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > 1) return contentLength;
      if (method === 'RANGE') await response.arrayBuffer();
    } catch (error) {
      console.error(`Size probe failed for ${url}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function unwrapEast(west, east) {
  return west > east ? east + 360 : east;
}

function splitLongitudeCell(west, east) {
  if (west < 180 && east > 180) {
    return [
      [west, 180],
      [-180, east - 360]
    ];
  }
  if (west >= 180) return [[west - 360, east - 360]];
  return [[west, east]];
}

function gridDimensions(bounds, desiredCells) {
  const [west, south, east, north] = bounds;
  const eastUnwrapped = unwrapEast(west, east);
  const longitudeSpan = Math.max(0.001, eastUnwrapped - west);
  const latitudeSpan = Math.max(0.001, north - south);
  const midLatitude = (south + north) / 2;
  const effectiveLongitudeSpan = longitudeSpan * Math.max(0.2, Math.cos((midLatitude * Math.PI) / 180));
  const aspect = effectiveLongitudeSpan / latitudeSpan;
  let columns = Math.max(1, Math.ceil(Math.sqrt(desiredCells * aspect)));
  let rows = Math.max(1, Math.ceil(desiredCells / columns));
  while (rows * columns < desiredCells) {
    if (columns / rows < aspect) columns += 1;
    else rows += 1;
  }
  return { rows, columns, eastUnwrapped };
}

function splitRegion(region, sourceSizeBytes) {
  const desiredCells = Math.min(
    MAX_SPLIT_CELLS,
    Math.max(4, Math.ceil(sourceSizeBytes / TARGET_SPLIT_PBF_BYTES))
  );
  const bounds = [region.west, region.south, region.east, region.north];
  const { rows, columns, eastUnwrapped } = gridDimensions(bounds, desiredCells);
  const longitudeStep = (eastUnwrapped - region.west) / columns;
  const latitudeStep = (region.north - region.south) / rows;
  const pieces = [];

  for (let row = 0; row < rows; row += 1) {
    const south = region.south + latitudeStep * row;
    const north = row === rows - 1 ? region.north : region.south + latitudeStep * (row + 1);
    for (let column = 0; column < columns; column += 1) {
      const cellWest = region.west + longitudeStep * column;
      const cellEast = column === columns - 1 ? eastUnwrapped : region.west + longitudeStep * (column + 1);
      const longitudePieces = splitLongitudeCell(cellWest, cellEast);
      longitudePieces.forEach(([west, east], segmentIndex) => {
        const suffix = longitudePieces.length > 1 ? `-s${segmentIndex + 1}` : '';
        const id = `${region.id}--r${row + 1}-c${column + 1}${suffix}`;
        const slug = slugify(id);
        const roundedWest = roundCoordinate(west);
        const roundedSouth = roundCoordinate(south);
        const roundedEast = roundCoordinate(east);
        const roundedNorth = roundCoordinate(north);
        pieces.push({
          id,
          slug,
          name: `${region.name} ${row + 1}.${column + 1}${suffix}`,
          continent: region.continent,
          pbf_url: region.pbf_url,
          extract_bbox: `${roundedWest},${roundedSouth},${roundedEast},${roundedNorth}`,
          source_region_id: region.id,
          source_size_bytes: sourceSizeBytes,
          west: roundedWest,
          south: roundedSouth,
          east: roundedEast,
          north: roundedNorth,
          asset_name: `occumed-${slug}.pmtiles`,
          metadata_name: `occumed-${slug}.json`
        });
      });
    }
  }

  console.error(
    `Subdividing ${region.id}: source=${sourceSizeBytes} bytes -> ${pieces.length} bounded PMTiles shards.`
  );
  return pieces;
}

async function expandOversizedRegions(regions) {
  if (!SIZE_AWARE || !regions.length) return regions;
  const sizes = await mapConcurrent(regions, SIZE_PROBE_CONCURRENCY, (region) =>
    fetchRemoteSize(region.pbf_url)
  );
  const expanded = [];
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    const size = sizes[index];
    if (Number.isFinite(size)) region.source_size_bytes = size;
    if (Number.isFinite(size) && size > DIRECT_PBF_LIMIT_BYTES) {
      expanded.push(...splitRegion(region, size));
    } else {
      expanded.push(region);
    }
  }
  expanded.sort((left, right) => left.id.localeCompare(right.id));
  return expanded;
}

const options = parseArgs(process.argv.slice(2));
const index = await loadIndex();
let regions = buildBasePlan(index, options.scope);
regions = await expandOversizedRegions(regions);
if (options.bucket !== null) {
  regions = regions.filter((_, indexValue) => indexValue % options.buckets === options.bucket);
}

process.stdout.write(`${JSON.stringify({ include: regions }, null, 2)}\n`);
