#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { PMTiles } from 'pmtiles';
import {
  EMPTY_MVT,
  inspectVectorTile,
  mergeVectorTiles,
  overscaleVectorLayer
} from '../src/server/mvt.js';
import { validateVectorTilePayload } from '../src/server/tile-safety.js';

class LocalSource {
  constructor(filename) {
    this.filename = path.resolve(filename);
    this.handlePromise = fs.open(this.filename, 'r');
  }

  getKey() {
    return this.filename;
  }

  async getBytes(offset, length) {
    const handle = await this.handlePromise;
    const size = Number(length);
    const buffer = Buffer.allocUnsafe(size);
    const result = await handle.read(buffer, 0, size, Number(offset));
    if (result.bytesRead !== size) {
      throw new Error(`Short PMTiles read from ${this.filename}: expected ${size}, received ${result.bytesRead}.`);
    }
    return {
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    };
  }

  async close() {
    await (await this.handlePromise).close();
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}.`);
    values.set(key, value);
    index += 1;
  }

  const required = ['detail', 'surface', 'z', 'x', 'y', 'output'];
  for (const key of required) {
    if (!values.has(key)) throw new Error(`Missing required --${key}.`);
  }

  const coordinates = Object.fromEntries(['z', 'x', 'y'].map((key) => [key, Number(values.get(key))]));
  if (!Object.values(coordinates).every(Number.isSafeInteger)) {
    throw new Error('Tile coordinates must be safe integers.');
  }
  if (coordinates.z < 0 || coordinates.z > 16) throw new Error('Tile zoom must be between 0 and 16.');
  const width = 2 ** coordinates.z;
  if (coordinates.x < 0 || coordinates.x >= width || coordinates.y < 0 || coordinates.y >= width) {
    throw new Error('Tile coordinates are outside the requested zoom pyramid.');
  }

  return {
    detailPath: path.resolve(values.get('detail')),
    surfacePath: path.resolve(values.get('surface')),
    outputPath: path.resolve(values.get('output')),
    reportPath: path.resolve(values.get('report') || `${values.get('output')}.report.json`),
    ...coordinates
  };
}

function payload(result) {
  return result?.data ? Buffer.from(result.data) : null;
}

async function readAuthoritativeSurface(archive, z, x, y, surfaceMaxZoom) {
  const layerNames = z <= 6 ? ['land', 'landcover', 'depth'] : ['land', 'depth'];

  if (z <= surfaceMaxZoom) {
    const direct = payload(await archive.getZxy(z, x, y));
    if (!direct) throw new Error(`Authoritative surface is missing ${z}/${x}/${y}.`);
    return mergeVectorTiles([direct], { includeLayers: layerNames, coordinateScale: 128 });
  }

  const divisor = 2 ** (z - surfaceMaxZoom);
  const sourceX = Math.floor(x / divisor);
  const sourceY = Math.floor(y / divisor);
  const ancestor = payload(await archive.getZxy(surfaceMaxZoom, sourceX, sourceY));
  if (!ancestor) {
    throw new Error(
      `Authoritative surface is missing ancestor ${surfaceMaxZoom}/${sourceX}/${sourceY} for ${z}/${x}/${y}.`
    );
  }

  const layers = layerNames.map((layerName) => overscaleVectorLayer(ancestor, {
    layerName,
    sourceZoom: surfaceMaxZoom,
    targetZoom: z,
    targetX: x,
    targetY: y
  }));
  return mergeVectorTiles(layers, { coordinateScale: 128 });
}

const options = parseArguments(process.argv.slice(2));
await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
await fs.mkdir(path.dirname(options.reportPath), { recursive: true });

const detailSource = new LocalSource(options.detailPath);
const surfaceSource = new LocalSource(options.surfacePath);
const detailArchive = new PMTiles(detailSource);
const surfaceArchive = new PMTiles(surfaceSource);

try {
  const [detailHeader, surfaceHeader] = await Promise.all([
    detailArchive.getHeader(),
    surfaceArchive.getHeader()
  ]);
  const detailPayload = payload(await detailArchive.getZxy(options.z, options.x, options.y));
  const authoritativeSurface = await readAuthoritativeSurface(
    surfaceArchive,
    options.z,
    options.x,
    options.y,
    Number(surfaceHeader.maxZoom)
  );

  const regionalCartography = options.z > 6 && detailPayload
    ? mergeVectorTiles([detailPayload], {
        excludeLayers: ['land', 'depth'],
        coordinateScale: 128
      })
    : EMPTY_MVT;

  const compiled = mergeVectorTiles(
    [authoritativeSurface, regionalCartography],
    { coordinateScale: 128 }
  );
  validateVectorTilePayload(compiled, {
    label: `offline owner tile ${options.z}/${options.x}/${options.y}`,
    coordinateScale: 128,
    maxBytes: 32 * 1024 * 1024
  });

  const layers = inspectVectorTile(compiled);
  if (!layers.land?.featureCount) {
    throw new Error(`Compiled tile ${options.z}/${options.x}/${options.y} has no authoritative land layer.`);
  }
  if (options.z > 6 && detailPayload && !layers.landcover?.featureCount) {
    const detailLayers = inspectVectorTile(detailPayload);
    if (detailLayers.landcover?.featureCount) {
      throw new Error('Regional landcover was present in the input but disappeared during offline compilation.');
    }
  }

  const temporary = `${options.outputPath}.pending-${process.pid}`;
  await fs.writeFile(temporary, compiled);
  await fs.rename(temporary, options.outputPath);

  const report = {
    generatedAt: new Date().toISOString(),
    tile: { z: options.z, x: options.x, y: options.y },
    detail: {
      path: options.detailPath,
      minZoom: Number(detailHeader.minZoom),
      maxZoom: Number(detailHeader.maxZoom),
      tilePresent: Boolean(detailPayload),
      admitted: options.z > 6 && Boolean(detailPayload)
    },
    surface: {
      path: options.surfacePath,
      minZoom: Number(surfaceHeader.minZoom),
      maxZoom: Number(surfaceHeader.maxZoom),
      authoritativeLayers: options.z <= 6 ? ['land', 'landcover', 'depth'] : ['land', 'depth']
    },
    policy: {
      lowZoomAuthority: 'world-surface-only-z0-z6',
      highZoomLandAuthority: 'world-surface-offline-transform-and-clip',
      highZoomLandcoverAuthority: 'regional-detail',
      syntheticLandcover: false,
      runtimeMerge: false
    },
    bytes: compiled.byteLength,
    layers
  };
  await fs.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Compiled offline owner tile ${options.z}/${options.x}/${options.y}: ${compiled.byteLength} bytes, layers ${Object.keys(layers).join(', ')}.`
  );
} finally {
  await Promise.allSettled([detailSource.close(), surfaceSource.close()]);
}
