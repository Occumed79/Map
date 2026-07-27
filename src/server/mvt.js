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
    // Point labels get one deterministic anchor. Lines and polygon rings retain
    // complementary pieces clipped into neighboring storage extracts.
    if (this.type !== 1) {
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
 * Planetiler preserves OSM feature IDs in the Occu-Med schema. When adjacent
 * extracts contain the same feature, complementary line and ring parts are
 * retained under one feature ID while contained duplicates collapse. Point
 * labels retain one anchor. No unrelated polygon rings are stitched together.
 */
export function mergeVectorTiles(payloads, {
  includeLayers,
  coordinateScale = 64
} = {}) {
  const allowedLayers = includeLayers ? new Set(includeLayers) : null;
  const layers = new Map();

  for (const payload of payloads.filter(Boolean)) {
    const tile = decodeTile(payload);
    for (const [name, sourceLayer] of Object.entries(tile.layers)) {
      if (allowedLayers && !allowedLayers.has(name)) continue;

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

class TransformedFeature {
  constructor(feature, scale, offsetX, offsetY, extent) {
    this.id = feature.id;
    this.type = feature.type;
    this.properties = normalizeMvtProperties(feature.properties);
    this.extent = extent;
    this.source = feature;
    this.scale = scale;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
  }

  loadGeometry() {
    return this.source.loadGeometry().map((line) =>
      line.map((point) => ({
        x: point.x * this.scale - this.offsetX,
        y: point.y * this.scale - this.offsetY
      }))
    );
  }
}

/**
 * Overscales one layer from an ancestor tile without changing its source-layer
 * name. MapLibre still receives one ordinary MVT payload at the requested Z/X/Y.
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
    features.push(
      new TransformedFeature(
        sourceLayer.feature(index),
        scale,
        offsetX,
        offsetY,
        sourceLayer.extent
      )
    );
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
        )
      }
    ])
  );
}
