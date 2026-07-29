import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_LAYERS = 256;
const DEFAULT_MAX_FEATURES = 500_000;
const DEFAULT_MAX_FEATURE_POINTS = 250_000;
const DEFAULT_MAX_TOTAL_POINTS = 4_000_000;
const DEFAULT_MAX_PROPERTIES = 256;
const DEFAULT_COORDINATE_SCALE = 128;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function safeLabel(value) {
  return String(value || 'vector tile').replace(/[\r\n\t]/g, ' ').slice(0, 200);
}

export function validateVectorTilePayload(payload, {
  label = 'vector tile',
  maxBytes = DEFAULT_MAX_BYTES,
  maxLayers = DEFAULT_MAX_LAYERS,
  maxFeatures = DEFAULT_MAX_FEATURES,
  maxFeaturePoints = DEFAULT_MAX_FEATURE_POINTS,
  maxTotalPoints = DEFAULT_MAX_TOTAL_POINTS,
  maxProperties = DEFAULT_MAX_PROPERTIES,
  coordinateScale = DEFAULT_COORDINATE_SCALE
} = {}) {
  const name = safeLabel(label);
  const bytes = Buffer.from(payload || []);
  const byteLimit = boundedInteger(maxBytes, DEFAULT_MAX_BYTES, 1_024, 96 * 1024 * 1024);
  // A protobuf message with no fields is canonically encoded as zero bytes.
  // Mapbox Vector Tile uses protobuf, so a zero-byte payload is the valid empty
  // tile used internally when no source layers are present. Non-empty malformed
  // payloads still fail during decoding below.
  if (bytes.byteLength > byteLimit) {
    throw new Error(`${name} has unsafe encoded size ${bytes.byteLength}.`);
  }

  let tile;
  try {
    tile = new VectorTile(new Pbf(new Uint8Array(bytes)));
  } catch (error) {
    throw new Error(`${name} is not a valid Mapbox Vector Tile.`, { cause: error });
  }

  const layerEntries = Object.entries(tile.layers || {});
  const layerLimit = boundedInteger(maxLayers, DEFAULT_MAX_LAYERS, 1, 2_048);
  if (layerEntries.length > layerLimit) {
    throw new Error(`${name} exceeds the ${layerLimit}-layer safety limit.`);
  }

  const featureLimit = boundedInteger(maxFeatures, DEFAULT_MAX_FEATURES, 1, 2_000_000);
  const featurePointLimit = boundedInteger(maxFeaturePoints, DEFAULT_MAX_FEATURE_POINTS, 4, 2_000_000);
  const totalPointLimit = boundedInteger(maxTotalPoints, DEFAULT_MAX_TOTAL_POINTS, 4, 16_000_000);
  const propertyLimit = boundedInteger(maxProperties, DEFAULT_MAX_PROPERTIES, 1, 4_096);
  const scale = boundedInteger(coordinateScale, DEFAULT_COORDINATE_SCALE, 1, 512);
  let totalFeatures = 0;
  let totalPoints = 0;

  for (const [layerName, layer] of layerEntries) {
    if (!layerName || layerName.length > 200) {
      throw new Error(`${name} contains an invalid source-layer name.`);
    }
    if (!Number.isSafeInteger(layer.extent) || layer.extent < 256 || layer.extent > 16_384) {
      throw new Error(`${name} layer ${layerName} has invalid extent ${layer.extent}.`);
    }
    if (!Number.isSafeInteger(layer.length) || layer.length < 0) {
      throw new Error(`${name} layer ${layerName} has an invalid feature count.`);
    }
    totalFeatures += layer.length;
    if (totalFeatures > featureLimit) {
      throw new Error(`${name} exceeds the ${featureLimit}-feature safety limit.`);
    }

    const coordinateLimit = layer.extent * scale;
    for (let index = 0; index < layer.length; index += 1) {
      let feature;
      try {
        feature = layer.feature(index);
      } catch (error) {
        throw new Error(`${name} cannot decode ${layerName} feature ${index}.`, { cause: error });
      }
      if (![1, 2, 3].includes(feature.type)) {
        throw new Error(`${name} contains an invalid geometry type in ${layerName}.`);
      }
      if (Object.keys(feature.properties || {}).length > propertyLimit) {
        throw new Error(`${name} feature ${layerName}/${index} exceeds the property safety limit.`);
      }

      let featurePoints = 0;
      let geometry;
      try {
        geometry = feature.loadGeometry();
      } catch (error) {
        throw new Error(`${name} cannot decode geometry for ${layerName}/${index}.`, { cause: error });
      }
      for (const part of geometry) {
        for (const point of part) {
          if (
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y) ||
            Math.abs(point.x) > coordinateLimit ||
            Math.abs(point.y) > coordinateLimit
          ) {
            throw new Error(`${name} contains unsafe coordinates in ${layerName}/${index}.`);
          }
          featurePoints += 1;
          totalPoints += 1;
          if (featurePoints > featurePointLimit) {
            throw new Error(`${name} feature ${layerName}/${index} exceeds the point safety limit.`);
          }
          if (totalPoints > totalPointLimit) {
            throw new Error(`${name} exceeds the ${totalPointLimit}-point safety limit.`);
          }
        }
      }
      if (!featurePoints) {
        throw new Error(`${name} contains empty geometry in ${layerName}/${index}.`);
      }
    }
  }

  return {
    bytes,
    layerCount: layerEntries.length,
    featureCount: totalFeatures,
    pointCount: totalPoints
  };
}
