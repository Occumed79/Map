import { createHash } from 'node:crypto';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import vtpbf from 'vt-pbf';

export const EMPTY_MVT = Buffer.from(vtpbf.fromVectorTileJs({ layers: {} }));

function decodeTile(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new VectorTile(new Pbf(bytes));
}

function stableProperties(properties) {
  return Object.keys(properties || {})
    .sort()
    .map((key) => [key, properties[key]]);
}

export function normalizeMvtProperties(properties) {
  return Object.fromEntries(
    Object.entries(properties || {}).map(([key, value]) => {
      if (typeof value === 'bigint') return [key, value.toString()];
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      ) {
        return [key, String(value)];
      }
      return [key, value];
    })
  );
}

function geometrySignature(feature) {
  const hash = createHash('sha1');
  hash.update(`${feature.type}|${JSON.stringify(stableProperties(feature.properties))}|`);
  for (const line of feature.loadGeometry()) {
    hash.update('[');
    for (const point of line) hash.update(`${point.x},${point.y};`);
    hash.update(']');
  }
  return hash.digest('base64url');
}

function featureKey(feature) {
  // Polygon IDs are not safe cross-extract identifiers. Planetiler-generated,
  // Natural Earth, bathymetry, and post-processed polygon layers can reuse the
  // same numeric ID in separate regional archives. Joining those rings by ID
  // creates giant wedges and bands when the merged MVT is encoded. Only exact
  // polygon geometry is deduplicated; unrelated rings remain separate features.
  if (feature.type === 3) {
    return `${feature.type}:shape:${geometrySignature(feature)}`;
  }
  if (feature.id !== undefined && feature.id !== null) {
    return `${feature.type}:id:${feature.id}`;
  }
  return `${feature.type}:shape:${geometrySignature(feature)}`;
}

function isSaneGeometry(feature, extent, coordinateScale = 64) {
  const limit = extent * coordinateScale;
  let pointCount = 0;
  for (const line of feature.loadGeometry()) {
    for (const point of line) {
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        Math.abs(point.x) > limit ||
        Math.abs(point.y) > limit
      ) {
        return false;
      }
      pointCount += 1;
    }
  }
  return pointCount > 0;
}

class MergedLayer {
  constructor(name, version, extent, features) {
    this.name = name;
    this.version = version;
    this.extent = extent;
    this.features = features;
    this.length = features.length;
  }

  feature(index) {
    return this.features[index];
  }
}

function pointsEqual(left, right) {
  return left.x === right.x && left.y === right.y;
}

function lineContains(line, candidate) {
  if (candidate.length > line.length) return false;
  for (let start = 0; start <= line.length - candidate.length; start += 1) {
    let forward = true;
    let reverse = true;
    for (let index = 0; index < candidate.length; index += 1) {
      forward &&= pointsEqual(line[start + index], candidate[index]);
      reverse &&= pointsEqual(
        line[start + index],
        candidate[candidate.length - index - 1]
      );
      if (!forward && !reverse) break;
    }
    if (forward || reverse) return true;
  }
  return false;
}

function mergeGeometryParts(existing, incoming) {
  const parts = existing.map((line) => line.map((point) => ({ ...point })));
  for (const candidate of incoming) {
    if (parts.some((line) => lineContains(line, candidate))) continue;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (lineContains(candidate, parts[index])) parts.splice(index, 1);
    }
    parts.push(candidate.map((point) => ({ ...point })));
  }
  return parts;
}

class CombinedFeature {
  constructor(feature) {
    this.id = feature.id;
    this.type = feature.type;
    this.properties = normalizeMvtProperties(feature.properties);
    this.extent = feature.extent;
    this.geometry = feature.loadGeometry();
  }

  merge(feature) {
    // Only line features are joined across extracts. Point labels keep one
    // deterministic anchor, and polygons are deduplicated only by exact shape.
    // Never append polygon rings from separate archives under a reused ID.
    if (this.type === 2) {
      this.geometry = mergeGeometryParts(this.geometry, feature.loadGeometry());
    }
  }

  loadGeometry() {
    return this.geometry;
  }
}

/**
 * Merges independently generated MVT payloads into one valid tile.
 *
 * Planetiler preserves OSM IDs for line and point features, which allows road
 * fragments and label anchors to be deduplicated across overlapping extracts.
 * Polygon IDs are not assumed to be globally unique: exact duplicate shapes
 * collapse, while unrelated rings remain separate features.
 */
export function mergeVectorTiles(payloads, {
  includeLayers,
  excludeLayers,
  coordinateScale = 64
} = {}) {
  const allowedLayers = includeLayers ? new Set(includeLayers) : null;
  const blockedLayers = excludeLayers ? new Set(excludeLayers) : null;
  const layers = new Map();

  for (const payload of payloads.filter(Boolean)) {
    const tile = decodeTile(payload);
    for (const [name, sourceLayer] of Object.entries(tile.layers)) {
      if (allowedLayers && !allowedLayers.has(name)) continue;
      if (blockedLayers?.has(name)) continue;

      let target = layers.get(name);
      if (!target) {
        target = {
          name,
          version: sourceLayer.version,
          extent: sourceLayer.extent,
          features: new Map()
        };
        layers.set(name, target);
      } else if (target.extent !== sourceLayer.extent) {
        throw new Error(
          `Cannot merge MVT layer ${name} with extents ${target.extent} and ${sourceLayer.extent}.`
        );
      }

      for (let index = 0; index < sourceLayer.length; index += 1) {
        const feature = sourceLayer.feature(index);
        if (!isSaneGeometry(feature, target.extent, coordinateScale)) continue;

        const key = featureKey(feature);
        const existing = target.features.get(key);
        if (existing) existing.merge(feature);
        else target.features.set(key, new CombinedFeature(feature));
      }
    }
  }

  if (!layers.size) return EMPTY_MVT;

  const encodedLayers = {};
  for (const [name, layer] of layers) {
    const features = [...layer.features.values()];
    if (!features.length) continue;
    encodedLayers[name] = new MergedLayer(
      name,
      layer.version,
      layer.extent,
      features
    );
  }

  if (!Object.keys(encodedLayers).length) return EMPTY_MVT;
  return Buffer.from(vtpbf.fromVectorTileJs({ layers: encodedLayers }));
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

function clipAgainstBoundary(points, inside, intersect) {
  if (!points.length) return [];
  const output = [];
  let previous = points.at(-1);
  let previousInside = inside(previous);

  for (const current of points) {
    const currentInside = inside(current);
    if (currentInside) {
      if (!previousInside) output.push(intersect(previous, current));
      output.push(current);
    } else if (previousInside) {
      output.push(intersect(previous, current));
    }
    previous = current;
    previousInside = currentInside;
  }
  return output;
}

function dedupeConsecutivePoints(points) {
  const output = [];
  for (const point of points) {
    const rounded = { x: Math.round(point.x), y: Math.round(point.y) };
    if (!output.length || !pointsEqual(output.at(-1), rounded)) output.push(rounded);
  }
  if (output.length > 1 && pointsEqual(output[0], output.at(-1))) output.pop();
  return output;
}

function clipPolygonRing(points, extent) {
  if (points.length < 3) return [];
  let ring = pointsEqual(points[0], points.at(-1)) ? points.slice(0, -1) : [...points];
  ring = clipAgainstBoundary(ring, (point) => point.x >= 0, (a, b) => interpolateAtX(a, b, 0));
  ring = clipAgainstBoundary(ring, (point) => point.x <= extent, (a, b) => interpolateAtX(a, b, extent));
  ring = clipAgainstBoundary(ring, (point) => point.y >= 0, (a, b) => interpolateAtY(a, b, 0));
  ring = clipAgainstBoundary(ring, (point) => point.y <= extent, (a, b) => interpolateAtY(a, b, extent));
  ring = dedupeConsecutivePoints(ring);
  if (ring.length < 3) return [];
  ring.push({ ...ring[0] });
  return ring.length >= 4 ? ring : [];
}

class TransformedFeature {
  constructor(feature, geometry, extent) {
    this.id = feature.id;
    this.type = feature.type;
    this.properties = normalizeMvtProperties(feature.properties);
    this.extent = extent;
    this.geometry = geometry;
  }

  loadGeometry() {
    return this.geometry;
  }
}

/**
 * Overscales one layer from an ancestor tile without changing its source-layer
 * name. Geometry is clipped to the requested child tile before encoding so an
 * ancestor polygon cannot spill across the globe as a giant wedge or band.
 */
export function overscaleVectorLayer(payload, {
  layerName,
  sourceZoom,
  targetZoom,
  targetX,
  targetY
}) {
  if (targetZoom < sourceZoom) {
    throw new Error('The target zoom must be greater than or equal to the source zoom.');
  }

  const tile = decodeTile(payload);
  const sourceLayer = tile.layers[layerName];
  if (!sourceLayer) return EMPTY_MVT;
  if (targetZoom === sourceZoom) {
    return mergeVectorTiles([payload], { includeLayers: [layerName] });
  }

  const scale = 2 ** (targetZoom - sourceZoom);
  const childX = ((targetX % scale) + scale) % scale;
  const childY = ((targetY % scale) + scale) % scale;
  const offsetX = childX * sourceLayer.extent;
  const offsetY = childY * sourceLayer.extent;
  const features = [];

  for (let index = 0; index < sourceLayer.length; index += 1) {
    const feature = sourceLayer.feature(index);
    const transformed = feature.loadGeometry().map((line) =>
      line.map((point) => ({
        x: point.x * scale - offsetX,
        y: point.y * scale - offsetY
      }))
    );
    const geometry = feature.type === 3
      ? transformed.map((ring) => clipPolygonRing(ring, sourceLayer.extent)).filter((ring) => ring.length)
      : transformed;
    if (!geometry.length) continue;
    features.push(new TransformedFeature(feature, geometry, sourceLayer.extent));
  }

  if (!features.length) return EMPTY_MVT;
  return Buffer.from(vtpbf.fromVectorTileJs({
    layers: {
      [layerName]: new MergedLayer(
        layerName,
        sourceLayer.version,
        sourceLayer.extent,
        features
      )
    }
  }));
}

export function inspectVectorTile(payload) {
  const tile = decodeTile(payload);
  return Object.fromEntries(
    Object.entries(tile.layers).map(([name, layer]) => [
      name,
      {
        extent: layer.extent,
        featureCount: layer.length,
        ids: Array.from({ length: layer.length }, (_, index) => layer.feature(index).id),
        pointCounts: Array.from({ length: layer.length }, (_, index) =>
          layer.feature(index).loadGeometry().reduce(
            (total, line) => total + line.length,
            0
          )
        ),
        bounds: Array.from({ length: layer.length }, (_, index) => {
          const geometry = layer.feature(index).loadGeometry().flat();
          return geometry.length
            ? {
                minX: Math.min(...geometry.map((point) => point.x)),
                minY: Math.min(...geometry.map((point) => point.y)),
                maxX: Math.max(...geometry.map((point) => point.x)),
                maxY: Math.max(...geometry.map((point) => point.y))
              }
            : null;
        })
      }
    ])
  );
}
