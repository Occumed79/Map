import { createHash } from 'node:crypto';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import vtpbf from 'vt-pbf';
import { validateVectorTilePayload } from '../../src/server/tile-safety.js';

const DEFAULT_EXTENT = 4096;
const INPUT_COORDINATE_SCALE = 128;
const MAX_FEATURE_POINTS = 250_000;
const MAX_TILE_POINTS = 2_000_000;
const SURFACE_RECTANGLE_LAYERS = new Set([
  'landcover',
  'landuse',
  'park',
  'protected_area',
  'water'
]);

const LAYER_ALIASES = new Map([
  ['aerodrome', 'aerodrome_label'],
  ['aerodrome_label', 'aerodrome_label'],
  ['aeroway', 'aeroway'],
  ['admin', 'boundary'],
  ['boundary', 'boundary'],
  ['building', 'building'],
  ['buildings', 'building'],
  ['depth', 'depth'],
  ['housenum_label', 'housenumber'],
  ['housenumber', 'housenumber'],
  ['land', 'land'],
  ['land_cover', 'landcover'],
  ['landcover', 'landcover'],
  ['landuse', 'landuse'],
  ['landuse_overlay', 'landuse'],
  ['mountain_peak', 'mountain_peak'],
  ['park', 'park'],
  ['place', 'place'],
  ['place_label', 'place'],
  ['poi', 'poi'],
  ['poi_label', 'poi'],
  ['protected_area', 'park'],
  ['road', 'transportation'],
  ['road_label', 'transportation_name'],
  ['transportation', 'transportation'],
  ['transportation_name', 'transportation_name'],
  ['water', 'water'],
  ['water_name', 'water_name'],
  ['waterway', 'waterway']
]);

function canonicalLayerName(name) {
  const normalized = String(name || '').trim().toLowerCase().replaceAll('-', '_');
  return LAYER_ALIASES.get(normalized) || normalized;
}

function normalizePropertyValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  ) {
    return String(value);
  }
  return value;
}

function normalizeProperties(layerName, properties = {}) {
  const output = Object.fromEntries(
    Object.entries(properties)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, normalizePropertyValue(value)])
  );
  if (output['name_en'] && !output['name:en']) output['name:en'] = output['name_en'];
  if (output.name && !output['name:latin']) output['name:latin'] = output.name;
  if (layerName === 'landcover') {
    if (output.class === 'farmland') output.class = 'crop';
    if (output.class === 'ice') output.class = 'snow';
    output.class ||= 'grass';
  }
  if (
    ['transportation', 'transportation_name'].includes(layerName) &&
    !output.class &&
    output.type
  ) {
    output.class = output.type;
  }
  if (layerName === 'building') {
    if (output.height !== undefined && output.render_height === undefined) {
      output.render_height = output.height;
    }
    if (output.min_height !== undefined && output.render_min_height === undefined) {
      output.render_min_height = output.min_height;
    }
  }
  return output;
}

function pointEqual(left, right) {
  return left.x === right.x && left.y === right.y;
}

function roundPoint(point) {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function dedupePoints(points, { close = false } = {}) {
  const result = [];
  for (const raw of points) {
    const point = roundPoint(raw);
    if (!result.length || !pointEqual(result.at(-1), point)) result.push(point);
  }
  while (result.length > 1 && pointEqual(result[0], result.at(-1))) result.pop();
  if (close && result.length >= 3) result.push({ ...result[0] });
  return result;
}

function interpolateAtX(start, end, x) {
  const delta = end.x - start.x;
  if (delta === 0) return { x, y: start.y };
  const ratio = (x - start.x) / delta;
  return { x, y: start.y + (end.y - start.y) * ratio };
}

function interpolateAtY(start, end, y) {
  const delta = end.y - start.y;
  if (delta === 0) return { x: start.x, y };
  const ratio = (y - start.y) / delta;
  return { x: start.x + (end.x - start.x) * ratio, y };
}

function clipPolygonBoundary(points, inside, intersect) {
  if (!points.length) return [];
  const result = [];
  let previous = points.at(-1);
  let previousInside = inside(previous);
  for (const current of points) {
    const currentInside = inside(current);
    if (currentInside) {
      if (!previousInside) result.push(intersect(previous, current));
      result.push(current);
    } else if (previousInside) {
      result.push(intersect(previous, current));
    }
    previous = current;
    previousInside = currentInside;
  }
  return result;
}

function clipPolygonRing(points, extent) {
  if (points.length < 3) return [];
  let ring = pointEqual(points[0], points.at(-1)) ? points.slice(0, -1) : [...points];
  ring = clipPolygonBoundary(ring, (point) => point.x >= 0, (a, b) => interpolateAtX(a, b, 0));
  ring = clipPolygonBoundary(ring, (point) => point.x <= extent, (a, b) => interpolateAtX(a, b, extent));
  ring = clipPolygonBoundary(ring, (point) => point.y >= 0, (a, b) => interpolateAtY(a, b, 0));
  ring = clipPolygonBoundary(ring, (point) => point.y <= extent, (a, b) => interpolateAtY(a, b, extent));
  ring = dedupePoints(ring, { close: true });
  return ring.length >= 4 ? ring : [];
}

function regionCode(point, extent) {
  let code = 0;
  if (point.x < 0) code |= 1;
  else if (point.x > extent) code |= 2;
  if (point.y < 0) code |= 4;
  else if (point.y > extent) code |= 8;
  return code;
}

function clipLineSegment(start, end, extent) {
  let left = { ...start };
  let right = { ...end };
  let leftCode = regionCode(left, extent);
  let rightCode = regionCode(right, extent);
  while (true) {
    if (!(leftCode | rightCode)) return [left, right];
    if (leftCode & rightCode) return null;
    const code = leftCode || rightCode;
    let point;
    if (code & 8) point = interpolateAtY(left, right, extent);
    else if (code & 4) point = interpolateAtY(left, right, 0);
    else if (code & 2) point = interpolateAtX(left, right, extent);
    else point = interpolateAtX(left, right, 0);
    if (code === leftCode) {
      left = point;
      leftCode = regionCode(left, extent);
    } else {
      right = point;
      rightCode = regionCode(right, extent);
    }
  }
}

function clipLineString(points, extent) {
  const fragments = [];
  let current = [];
  for (let index = 1; index < points.length; index += 1) {
    const clipped = clipLineSegment(points[index - 1], points[index], extent);
    if (!clipped) {
      if (current.length >= 2) fragments.push(dedupePoints(current));
      current = [];
      continue;
    }
    const [start, end] = clipped;
    if (!current.length) current.push(start, end);
    else if (pointEqual(roundPoint(current.at(-1)), roundPoint(start))) current.push(end);
    else {
      if (current.length >= 2) fragments.push(dedupePoints(current));
      current = [start, end];
    }
  }
  if (current.length >= 2) fragments.push(dedupePoints(current));
  return fragments.filter((fragment) => fragment.length >= 2);
}

function transformAndClipGeometry(feature, {
  scale,
  offsetX,
  offsetY,
  extent
}) {
  const transformed = [];
  let pointCount = 0;
  for (const part of feature.loadGeometry()) {
    const points = [];
    for (const point of part) {
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        Math.abs(point.x) > feature.extent * INPUT_COORDINATE_SCALE ||
        Math.abs(point.y) > feature.extent * INPUT_COORDINATE_SCALE
      ) {
        return { geometry: [], pointCount, malformed: true };
      }
      points.push({
        x: point.x * scale - offsetX,
        y: point.y * scale - offsetY
      });
      pointCount += 1;
      if (pointCount > MAX_FEATURE_POINTS) {
        return { geometry: [], pointCount, oversized: true };
      }
    }
    if (feature.type === 1) {
      transformed.push(
        ...points
          .filter((point) => point.x >= 0 && point.x <= extent && point.y >= 0 && point.y <= extent)
          .map((point) => [roundPoint(point)])
      );
    } else if (feature.type === 2) {
      transformed.push(...clipLineString(points, extent));
    } else if (feature.type === 3) {
      const ring = clipPolygonRing(points, extent);
      if (ring.length) transformed.push(ring);
    }
  }
  return { geometry: transformed, pointCount };
}

function geometryBounds(geometry) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let points = 0;
  for (const part of geometry) {
    for (const point of part) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      points += 1;
    }
  }
  return points ? { minX, minY, maxX, maxY, points } : null;
}

function isLargeAxisAlignedRectangle(feature, extent) {
  if (feature.type !== 3 || !SURFACE_RECTANGLE_LAYERS.has(feature.layerName)) return false;
  const bounds = feature.bounds;
  if (!bounds) return false;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width <= 0 || height <= 0 || (width * height) / (extent * extent) < 0.06) {
    return false;
  }

  const points = feature.geometry.flat();
  if (points.length < 4) return false;
  const epsilon = 1;
  const onBoundary = (point) =>
    Math.abs(point.x - bounds.minX) <= epsilon ||
    Math.abs(point.x - bounds.maxX) <= epsilon ||
    Math.abs(point.y - bounds.minY) <= epsilon ||
    Math.abs(point.y - bounds.maxY) <= epsilon;
  if (!points.every(onBoundary)) return false;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      Math.abs(previous.x - current.x) > epsilon &&
      Math.abs(previous.y - current.y) > epsilon
    ) {
      return false;
    }
  }
  return true;
}

function stableProperties(properties) {
  return JSON.stringify(
    Object.entries(properties)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function geometrySignature(feature) {
  const hash = createHash('sha1');
  hash.update(`${feature.type}|${stableProperties(feature.properties)}|`);
  for (const part of feature.geometry) {
    hash.update('[');
    for (const point of part) hash.update(`${point.x},${point.y};`);
    hash.update(']');
  }
  return hash.digest('base64url');
}

function boxesIntersect(left, right) {
  return !(
    left.maxX < right.minX ||
    left.minX > right.maxX ||
    left.maxY < right.minY ||
    left.minY > right.maxY
  );
}

function orientation(a, b, c) {
  return Math.sign((b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y));
}

function pointOnSegment(a, b, point) {
  return (
    point.x >= Math.min(a.x, b.x) &&
    point.x <= Math.max(a.x, b.x) &&
    point.y >= Math.min(a.y, b.y) &&
    point.y <= Math.max(a.y, b.y) &&
    orientation(a, b, point) === 0
  );
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && pointOnSegment(a, b, c)) ||
    (o2 === 0 && pointOnSegment(a, b, d)) ||
    (o3 === 0 && pointOnSegment(c, d, a)) ||
    (o4 === 0 && pointOnSegment(c, d, b))
  );
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index];
    const b = ring[previous];
    if (pointOnSegment(a, b, point)) return true;
    const intersects =
      (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function ringsCross(left, right) {
  for (let leftIndex = 1; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex < right.length; rightIndex += 1) {
      if (
        segmentsIntersect(
          left[leftIndex - 1],
          left[leftIndex],
          right[rightIndex - 1],
          right[rightIndex]
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function polygonContains(container, candidate) {
  if (!boxesIntersect(container.bounds, candidate.bounds)) return false;
  if (
    container.bounds.minX > candidate.bounds.minX ||
    container.bounds.minY > candidate.bounds.minY ||
    container.bounds.maxX < candidate.bounds.maxX ||
    container.bounds.maxY < candidate.bounds.maxY
  ) {
    return false;
  }
  const containerRing = container.geometry[0];
  const candidateRing = candidate.geometry[0];
  if (!containerRing?.length || !candidateRing?.length) return false;
  if (ringsCross(containerRing, candidateRing)) return false;
  return candidateRing.slice(0, -1).every((point) => pointInRing(point, containerRing));
}

function bucketKeys(bounds, extent, bucketCount = 16) {
  const size = extent / bucketCount;
  const minX = Math.max(0, Math.min(bucketCount - 1, Math.floor(bounds.minX / size)));
  const minY = Math.max(0, Math.min(bucketCount - 1, Math.floor(bounds.minY / size)));
  const maxX = Math.max(0, Math.min(bucketCount - 1, Math.floor(bounds.maxX / size)));
  const maxY = Math.max(0, Math.min(bucketCount - 1, Math.floor(bounds.maxY / size)));
  const keys = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) keys.push(`${x}/${y}`);
  }
  return keys;
}

function dedupeAndRejectLayer(features, extent, report) {
  const ordered = [...features].sort((left, right) => {
    const properties = stableProperties(left.properties).localeCompare(stableProperties(right.properties));
    return properties || geometrySignature(left).localeCompare(geometrySignature(right));
  });
  const accepted = [];
  const exact = new Set();
  const buckets = new Map();

  for (const feature of ordered) {
    if (isLargeAxisAlignedRectangle(feature, extent)) {
      report.rejectedTileFootprints += 1;
      continue;
    }
    const signature = geometrySignature(feature);
    if (exact.has(signature)) {
      report.removedExactDuplicates += 1;
      continue;
    }

    if (feature.type === 3) {
      const properties = stableProperties(feature.properties);
      const candidates = new Set();
      for (const key of bucketKeys(feature.bounds, extent)) {
        for (const index of buckets.get(key) || []) candidates.add(index);
      }
      let contained = false;
      for (const index of candidates) {
        const existing = accepted[index];
        if (!existing || existing.removed || stableProperties(existing.properties) !== properties) continue;
        if (polygonContains(existing, feature)) {
          contained = true;
          report.removedContainedOverlaps += 1;
          break;
        }
        if (polygonContains(feature, existing)) {
          existing.removed = true;
          report.removedContainedOverlaps += 1;
        }
      }
      if (contained) continue;
    }

    exact.add(signature);
    const index = accepted.length;
    accepted.push(feature);
    if (feature.type === 3) {
      for (const key of bucketKeys(feature.bounds, extent)) {
        const list = buckets.get(key) || [];
        list.push(index);
        buckets.set(key, list);
      }
    }
  }

  const result = accepted.filter((feature) => !feature.removed);
  if (result[0]?.layerName === 'depth') {
    result.sort((left, right) => {
      const leftDepth = Number(left.properties.min_depth || 0);
      const rightDepth = Number(right.properties.min_depth || 0);
      return leftDepth - rightDepth || geometrySignature(left).localeCompare(geometrySignature(right));
    });
  }
  return result;
}

class EncodedFeature {
  constructor(feature) {
    this.id = feature.id;
    this.type = feature.type;
    this.properties = feature.properties;
    this.extent = feature.extent;
    this.geometry = feature.geometry;
  }

  loadGeometry() {
    return this.geometry;
  }
}

class EncodedLayer {
  constructor(name, features, extent = DEFAULT_EXTENT) {
    this.name = name;
    this.version = 2;
    this.extent = extent;
    this.features = features.map((feature) => new EncodedFeature(feature));
    this.length = this.features.length;
  }

  feature(index) {
    return this.features[index];
  }
}

function decodeTile(payload, label) {
  const bytes = validateVectorTilePayload(payload, {
    label,
    coordinateScale: INPUT_COORDINATE_SCALE,
    maxBytes: 32 * 1024 * 1024
  }).bytes;
  return new VectorTile(new Pbf(new Uint8Array(bytes)));
}

/**
 * Normalize selected source layers from one MVT into an exact target z/x/y.
 */
export function normalizeTileContribution(payload, {
  sourceZoom,
  targetZoom,
  targetX,
  targetY,
  includeLayers,
  excludeLayers,
  authority,
  report
}) {
  if (!payload) return [];
  const tile = decodeTile(payload, `offline ${authority} input`);
  const include = includeLayers ? new Set(includeLayers.map(canonicalLayerName)) : null;
  const exclude = excludeLayers ? new Set(excludeLayers.map(canonicalLayerName)) : null;
  const scale = 2 ** (targetZoom - sourceZoom);
  if (scale < 1) throw new Error('Offline materialization cannot downscale from a child tile.');
  const childX = ((targetX % scale) + scale) % scale;
  const childY = ((targetY % scale) + scale) % scale;
  const output = [];
  let tilePoints = 0;

  for (const [inputName, layer] of Object.entries(tile.layers)) {
    const layerName = canonicalLayerName(inputName);
    if (include && !include.has(layerName)) continue;
    if (exclude?.has(layerName)) continue;
    for (let index = 0; index < layer.length; index += 1) {
      const sourceFeature = layer.feature(index);
      const normalized = transformAndClipGeometry(sourceFeature, {
        scale,
        offsetX: childX * layer.extent,
        offsetY: childY * layer.extent,
        extent: layer.extent
      });
      if (normalized.malformed) {
        report.rejectedMalformed += 1;
        continue;
      }
      if (normalized.oversized) {
        report.rejectedOversized += 1;
        continue;
      }
      if (!normalized.geometry.length) {
        report.clippedEmpty += 1;
        continue;
      }
      tilePoints += normalized.geometry.reduce(
        (sum, part) => sum + part.length,
        0
      );
      if (tilePoints > MAX_TILE_POINTS) {
        throw new Error(`Offline tile exceeded ${MAX_TILE_POINTS} normalized geometry points.`);
      }
      const feature = {
        id: sourceFeature.id,
        type: sourceFeature.type,
        properties: normalizeProperties(layerName, sourceFeature.properties),
        extent: layer.extent,
        geometry: normalized.geometry,
        bounds: geometryBounds(normalized.geometry),
        layerName,
        authority
      };
      output.push(feature);
    }
  }
  return output;
}

export function encodeNormalizedTile(contributions, {
  label = 'offline normalized tile',
  report = {}
} = {}) {
  Object.assign(report, {
    rejectedMalformed: report.rejectedMalformed || 0,
    rejectedOversized: report.rejectedOversized || 0,
    rejectedTileFootprints: report.rejectedTileFootprints || 0,
    removedExactDuplicates: report.removedExactDuplicates || 0,
    removedContainedOverlaps: report.removedContainedOverlaps || 0,
    clippedEmpty: report.clippedEmpty || 0
  });
  const grouped = new Map();
  for (const feature of contributions) {
    const list = grouped.get(feature.layerName) || [];
    list.push(feature);
    grouped.set(feature.layerName, list);
  }

  const layers = {};
  for (const [layerName, features] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const extent = features[0]?.extent || DEFAULT_EXTENT;
    const normalized = dedupeAndRejectLayer(features, extent, report);
    if (normalized.length) layers[layerName] = new EncodedLayer(layerName, normalized, extent);
  }
  const encoded = Buffer.from(vtpbf.fromVectorTileJs({ layers }));
  validateVectorTilePayload(encoded, {
    label,
    coordinateScale: 1,
    maxBytes: 32 * 1024 * 1024,
    maxTotalPoints: MAX_TILE_POINTS
  });
  report.layers = Object.fromEntries(
    Object.entries(layers).map(([name, layer]) => [
      name,
      {
        featureCount: layer.length,
        pointCount: layer.features.reduce(
          (sum, feature) => sum + feature.geometry.reduce((partSum, part) => partSum + part.length, 0),
          0
        )
      }
    ])
  );
  report.bytes = encoded.byteLength;
  return encoded;
}

export async function readTileOrAncestor(openedArchive, z, x, y) {
  const maxZoom = Number(openedArchive.header.maxZoom);
  const sourceZoom = Math.min(z, maxZoom);
  const divisor = 2 ** (z - sourceZoom);
  const sourceX = Math.floor(x / divisor);
  const sourceY = Math.floor(y / divisor);
  const result = await openedArchive.archive.getZxy(sourceZoom, sourceX, sourceY);
  return {
    payload: result?.data ? Buffer.from(result.data) : null,
    sourceZoom,
    sourceX,
    sourceY
  };
}

/**
 * Compile one final immutable tile with a strict offline authority matrix:
 * surface -> land/depth, overview -> landcover, regional -> cartography.
 */
export async function compileImmutableTile({
  z,
  x,
  y,
  surface,
  overview,
  regional = []
}) {
  const report = {
    tile: { z, x, y },
    authorities: {
      land: 'world-surface',
      depth: 'world-surface',
      landcover: 'world-overview',
      cartography: 'regional-owner'
    },
    policy: {
      syntheticLandcover: false,
      runtimeMerge: false,
      runtimeGeometry: false,
      parentChildStretching: false
    },
    rejectedMalformed: 0,
    rejectedOversized: 0,
    rejectedTileFootprints: 0,
    removedExactDuplicates: 0,
    removedContainedOverlaps: 0,
    clippedEmpty: 0
  };
  const [surfaceTile, overviewTile] = await Promise.all([
    readTileOrAncestor(surface, z, x, y),
    readTileOrAncestor(overview, z, x, y)
  ]);
  const contributions = [];
  if (surfaceTile.payload) {
    contributions.push(
      ...normalizeTileContribution(surfaceTile.payload, {
        sourceZoom: surfaceTile.sourceZoom,
        targetZoom: z,
        targetX: x,
        targetY: y,
        includeLayers: ['land', 'depth'],
        authority: 'world-surface',
        report
      })
    );
  }
  if (overviewTile.payload) {
    contributions.push(
      ...normalizeTileContribution(overviewTile.payload, {
        sourceZoom: overviewTile.sourceZoom,
        targetZoom: z,
        targetX: x,
        targetY: y,
        includeLayers: ['landcover'],
        authority: 'world-overview',
        report
      })
    );
    if (z <= Number(overview.header.maxZoom)) {
      contributions.push(
        ...normalizeTileContribution(overviewTile.payload, {
          sourceZoom: overviewTile.sourceZoom,
          targetZoom: z,
          targetX: x,
          targetY: y,
          excludeLayers: ['land', 'landcover', 'depth'],
          authority: 'world-overview-cartography',
          report
        })
      );
    }
  }
  if (z > Number(overview.header.maxZoom)) {
    for (const opened of regional) {
      const result = await opened.archive.getZxy(z, x, y);
      if (!result?.data) continue;
      contributions.push(
        ...normalizeTileContribution(Buffer.from(result.data), {
          sourceZoom: z,
          targetZoom: z,
          targetX: x,
          targetY: y,
          excludeLayers: ['land', 'landcover', 'depth'],
          authority: opened.assetName || opened.source?.filename || 'regional-cartography',
          report
        })
      );
    }
  }
  return {
    data: encodeNormalizedTile(contributions, {
      label: `immutable offline tile ${z}/${x}/${y}`,
      report
    }),
    report
  };
}
