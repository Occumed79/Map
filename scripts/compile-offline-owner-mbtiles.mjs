#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { inspectVectorTile, mergeVectorTiles } from '../src/server/mvt.js';
import { validateVectorTilePayload } from '../src/server/tile-safety.js';

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    values.set(token.slice(2), value);
    index += 1;
  }
  for (const required of ['family', 'detail', 'land', 'output-dir']) {
    if (!values.has(required)) throw new Error(`Missing --${required}.`);
  }
  const routingZoom = Number(values.get('routing-zoom') || 11);
  const targetBytes = Number(values.get('target-bytes') || 650_000_000);
  if (!Number.isSafeInteger(routingZoom) || routingZoom < 7 || routingZoom > 14) {
    throw new Error('--routing-zoom must be an integer from 7 to 14.');
  }
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 100_000_000) {
    throw new Error('--target-bytes must be at least 100000000.');
  }
  return {
    family: values.get('family'),
    detailPath: path.resolve(values.get('detail')),
    landPath: path.resolve(values.get('land')),
    outputDir: path.resolve(values.get('output-dir')),
    routingZoom,
    targetBytes
  };
}

function decodeTile(value) {
  if (!value) return null;
  const bytes = Buffer.from(value);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipSync(bytes);
  return bytes;
}

function xyzY(z, tmsY) {
  return 2 ** z - 1 - tmsY;
}

function ownerCell(z, x, tmsY, routingZoom) {
  const y = xyzY(z, tmsY);
  const shift = z - routingZoom;
  if (shift < 0) throw new Error(`Tile ${z}/${x}/${y} is below routing zoom ${routingZoom}.`);
  return {
    x: Math.floor(x / 2 ** shift),
    y: Math.floor(y / 2 ** shift)
  };
}

function createOutputDatabase(filename, metadata) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=OFF;
    PRAGMA synchronous=OFF;
    PRAGMA temp_store=MEMORY;
    CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE tiles (
      zoom_level INTEGER NOT NULL,
      tile_column INTEGER NOT NULL,
      tile_row INTEGER NOT NULL,
      tile_data BLOB NOT NULL
    );
  `);
  const insertMetadata = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  for (const [name, value] of Object.entries(metadata)) insertMetadata.run(name, String(value));
  return {
    db,
    insert: db.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'),
    count: 0,
    bytes: 0,
    hash: createHash('sha256')
  };
}

const options = parseArgs(process.argv.slice(2));
await fsp.mkdir(options.outputDir, { recursive: true });

const detail = new DatabaseSync(options.detailPath, { readOnly: true });
detail.exec(`ATTACH DATABASE '${options.landPath.replaceAll("'", "''")}' AS landdb`);

const unionRows = detail.prepare(`
  SELECT zoom_level, tile_column, tile_row, SUM(source_bytes) AS estimated_bytes
  FROM (
    SELECT zoom_level, tile_column, tile_row, length(tile_data) AS source_bytes
    FROM main.tiles WHERE zoom_level >= ?
    UNION ALL
    SELECT zoom_level, tile_column, tile_row, length(tile_data) AS source_bytes
    FROM landdb.tiles WHERE zoom_level >= ?
  )
  GROUP BY zoom_level, tile_column, tile_row
  ORDER BY zoom_level, tile_column, tile_row
`);

const cellEstimates = new Map();
let tileCount = 0;
for (const row of unionRows.iterate(options.routingZoom, options.routingZoom)) {
  const cell = ownerCell(Number(row.zoom_level), Number(row.tile_column), Number(row.tile_row), options.routingZoom);
  const key = `${cell.x}/${cell.y}`;
  cellEstimates.set(key, (cellEstimates.get(key) || 0) + Number(row.estimated_bytes || 0));
  tileCount += 1;
}
if (!tileCount) throw new Error(`No tiles at or above zoom ${options.routingZoom} for ${options.family}.`);

const cells = [...cellEstimates.entries()]
  .map(([key, estimatedBytes]) => {
    const [x, y] = key.split('/').map(Number);
    return { key, x, y, estimatedBytes };
  })
  .sort((a, b) => a.y - b.y || a.x - b.x);

const partitions = [];
let current = null;
for (const cell of cells) {
  const weightedBytes = Math.ceil(cell.estimatedBytes * 1.35);
  if (!current || (current.estimatedBytes + weightedBytes > options.targetBytes && current.cells.length)) {
    current = { index: partitions.length + 1, cells: [], estimatedBytes: 0 };
    partitions.push(current);
  }
  current.cells.push(cell);
  current.estimatedBytes += weightedBytes;
}

const metadataRows = detail.prepare('SELECT name, value FROM main.metadata').all();
const baseMetadata = Object.fromEntries(metadataRows.map((row) => [String(row.name), String(row.value)]));
const cellToPartition = new Map();
const outputs = [];
for (const partition of partitions) {
  const suffix = String(partition.index).padStart(3, '0');
  const mbtilesName = `occumed-owner-${options.family}-p${suffix}.mbtiles`;
  const filename = path.join(options.outputDir, mbtilesName);
  const output = createOutputDatabase(filename, {
    ...baseMetadata,
    name: `Occu-Med owner ${options.family} partition ${partition.index}`,
    description: `Immutable offline-compiled owner partition for ${options.family}`,
    format: 'pbf',
    compression: 'gzip',
    scheme: 'tms',
    minzoom: options.routingZoom,
    maxzoom: 16,
    'occumed:family': options.family,
    'occumed:routing_zoom': options.routingZoom,
    'occumed:runtime_merge': false,
    'occumed:synthetic_landcover': false
  });
  output.partition = partition;
  output.filename = filename;
  outputs.push(output);
  for (const cell of partition.cells) cellToPartition.set(cell.key, output);
}

const getDetail = detail.prepare(
  'SELECT tile_data FROM main.tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
);
const getLand = detail.prepare(
  'SELECT tile_data FROM landdb.tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
);
const processRows = detail.prepare(`
  SELECT zoom_level, tile_column, tile_row
  FROM (
    SELECT zoom_level, tile_column, tile_row FROM main.tiles WHERE zoom_level >= ?
    UNION
    SELECT zoom_level, tile_column, tile_row FROM landdb.tiles WHERE zoom_level >= ?
  )
  ORDER BY zoom_level, tile_column, tile_row
`);

for (const output of outputs) output.db.exec('BEGIN');
let processed = 0;
try {
  for (const row of processRows.iterate(options.routingZoom, options.routingZoom)) {
    const z = Number(row.zoom_level);
    const x = Number(row.tile_column);
    const tmsY = Number(row.tile_row);
    const y = xyzY(z, tmsY);
    const cell = ownerCell(z, x, tmsY, options.routingZoom);
    const output = cellToPartition.get(`${cell.x}/${cell.y}`);
    if (!output) throw new Error(`No deterministic owner partition for ${z}/${x}/${y}.`);

    const detailTile = decodeTile(getDetail.get(z, x, tmsY)?.tile_data);
    const landTile = decodeTile(getLand.get(z, x, tmsY)?.tile_data);
    const cartography = detailTile
      ? mergeVectorTiles([detailTile], { excludeLayers: ['land', 'depth'], coordinateScale: 128 })
      : null;
    const compiled = mergeVectorTiles([landTile, cartography].filter(Boolean), { coordinateScale: 128 });
    validateVectorTilePayload(compiled, {
      label: `offline owner ${options.family} ${z}/${x}/${y}`,
      coordinateScale: 128,
      maxBytes: 32 * 1024 * 1024
    });

    if (landTile) {
      const layers = inspectVectorTile(compiled);
      if (!layers.land?.featureCount) throw new Error(`Authoritative land disappeared at ${z}/${x}/${y}.`);
    }
    if (detailTile) {
      const detailLayers = inspectVectorTile(detailTile);
      if (detailLayers.landcover?.featureCount) {
        const layers = inspectVectorTile(compiled);
        if (!layers.landcover?.featureCount) throw new Error(`Regional landcover disappeared at ${z}/${x}/${y}.`);
      }
    }

    const encoded = gzipSync(compiled, { level: 6 });
    output.insert.run(z, x, tmsY, encoded);
    output.count += 1;
    output.bytes += encoded.byteLength;
    output.hash.update(`${z}/${x}/${y}:${encoded.byteLength}\n`);
    processed += 1;

    if (processed % 10_000 === 0) {
      for (const candidate of outputs) {
        candidate.db.exec('COMMIT; BEGIN');
      }
      console.log(`Compiled ${processed}/${tileCount} owner tiles for ${options.family}.`);
    }
  }
  for (const output of outputs) output.db.exec('COMMIT');
} catch (error) {
  for (const output of outputs) {
    try { output.db.exec('ROLLBACK'); } catch {}
  }
  throw error;
}

const manifest = {
  generatedAt: new Date().toISOString(),
  family: options.family,
  routingZoom: options.routingZoom,
  minZoom: options.routingZoom,
  maxZoom: 16,
  tileCount: processed,
  runtimeMerge: false,
  syntheticLandcover: false,
  authority: {
    land: 'natural-earth-v5.1.2-exact-region-clip',
    landcover: 'regional-osm-detail',
    depth: 'global-foundation-z0-z10'
  },
  partitions: []
};

for (const output of outputs) {
  output.db.exec('CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row); ANALYZE;');
  output.db.close();
  manifest.partitions.push({
    mbtiles: path.basename(output.filename),
    cells: output.partition.cells.map((cell) => ({ z: options.routingZoom, x: cell.x, y: cell.y })),
    estimatedInputBytes: output.partition.estimatedBytes,
    tileCount: output.count,
    compressedTileBytes: output.bytes,
    tileIndexSha256: output.hash.digest('hex')
  });
}

detail.close();
await fsp.writeFile(
  path.join(options.outputDir, `occumed-owner-${options.family}.manifest.json`),
  `${JSON.stringify(manifest, null, 2)}\n`
);
console.log(`Compiled ${processed} tiles for ${options.family} into ${outputs.length} deterministic owner partitions.`);
