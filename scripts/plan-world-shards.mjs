#!/usr/bin/env node

const INDEX_URL = process.env.GEOFABRIK_INDEX_URL || 'https://download.geofabrik.de/index-v1.json';
const DEFAULT_BUCKETS = 6;
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
  if (options.bucket !== null && (!Number.isSafeInteger(options.bucket) || options.bucket < 0 || options.bucket >= options.buckets)) {
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

function geometryBounds(geometry) {
  if (!geometry?.coordinates) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  walkCoordinates(geometry.coordinates, (longitude, latitude) => {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  });
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return [west, south, east, north];
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
  const response = await fetch(INDEX_URL, {
    headers: { 'User-Agent': 'Occu-Med-Map/world-pmtiles-planner' }
  });
  if (!response.ok) throw new Error(`Unable to load Geofabrik index (${response.status}).`);
  return response.json();
}

function buildPlan(index, scope) {
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

  const selected = [];
  for (const entry of entries) {
    if (!entry.pbfUrl || !entry.bounds) continue;
    const root = ancestorRoot(entry.id, byId) || entry.id;
    if (scope !== 'all' && root !== scope && entry.id !== scope) continue;

    const downloadableChildren = (children.get(entry.id) || [])
      .map((childId) => byId.get(childId))
      .filter((child) => child?.pbfUrl);

    // Leaf extracts keep worldwide shards small enough for independent builds
    // and avoid overlapping parent archives in the runtime manifest.
    if (downloadableChildren.length > 0) continue;

    const [west, south, east, north] = entry.bounds;
    const slug = slugify(entry.id);
    selected.push({
      id: entry.id,
      slug,
      name: entry.name,
      continent: root,
      pbf_url: entry.pbfUrl,
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

const options = parseArgs(process.argv.slice(2));
const index = await loadIndex();
let regions = buildPlan(index, options.scope);
if (options.bucket !== null) {
  regions = regions.filter((_, indexValue) => indexValue % options.buckets === options.bucket);
}

process.stdout.write(`${JSON.stringify({ include: regions }, null, 2)}\n`);
