const WEB_MERCATOR_LIMIT = 85.0511287798066;
const DEFAULT_MAX_CELL_FANOUT = 64;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeLongitude(longitude) {
  if (longitude === 180) return 180;
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function longitudeToTileX(longitude, zoom) {
  const count = 2 ** zoom;
  const normalized = clamp(longitude, -180, 180);
  return clamp(Math.floor(((normalized + 180) / 360) * count), 0, count - 1);
}

function latitudeToTileY(latitude, zoom) {
  const count = 2 ** zoom;
  const normalized = clamp(latitude, -WEB_MERCATOR_LIMIT, WEB_MERCATOR_LIMIT);
  const radians = normalized * Math.PI / 180;
  const value = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2;
  return clamp(Math.floor(value * count), 0, count - 1);
}

function tileLatitude(y, zoom) {
  const mercator = Math.PI * (1 - (2 * y) / (2 ** zoom));
  return Math.atan(Math.sinh(mercator)) * 180 / Math.PI;
}

export function normalizeTileCoordinates(zoom, x, y, maximumZoom = 16) {
  const parsed = [zoom, x, y].map(Number);
  if (!parsed.every(Number.isSafeInteger)) return null;

  const [z, tileX, tileY] = parsed;
  if (z < 0 || z > maximumZoom) return null;
  const count = 2 ** z;
  if (tileX < 0 || tileX >= count || tileY < 0 || tileY >= count) return null;
  return { z, x: tileX, y: tileY };
}

export function tileBounds(zoom, x, y) {
  const coordinates = normalizeTileCoordinates(zoom, x, y, 22);
  if (!coordinates) throw new RangeError('Invalid tile coordinates.');
  const count = 2 ** coordinates.z;
  return [
    (coordinates.x / count) * 360 - 180,
    tileLatitude(coordinates.y + 1, coordinates.z),
    ((coordinates.x + 1) / count) * 360 - 180,
    tileLatitude(coordinates.y, coordinates.z)
  ];
}

function regionSegments(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return [];
  let [west, south, east, north] = bounds.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return [];

  west = normalizeLongitude(west);
  east = east === 180 ? 180 : normalizeLongitude(east);
  south = clamp(south, -WEB_MERCATOR_LIMIT, WEB_MERCATOR_LIMIT);
  north = clamp(north, -WEB_MERCATOR_LIMIT, WEB_MERCATOR_LIMIT);
  if (south >= north) return [];

  return west <= east
    ? [[west, south, east, north]]
    : [[west, south, 180, north], [-180, south, east, north]];
}

function intersects(left, right) {
  const epsilon = 1e-10;
  return (
    left[0] < right[2] - epsilon &&
    left[2] > right[0] + epsilon &&
    left[1] < right[3] - epsilon &&
    left[3] > right[1] + epsilon
  );
}

function cellKey(x, y) {
  return `${x}/${y}`;
}

function compareRegions(left, right) {
  return String(left.asset || left.id).localeCompare(String(right.asset || right.id));
}

export class WorldTileRoutingIndex {
  constructor(regions, {
    routingZoom = 6,
    maxCellFanout = DEFAULT_MAX_CELL_FANOUT
  } = {}) {
    if (!Number.isSafeInteger(routingZoom) || routingZoom < 0 || routingZoom > 22) {
      throw new RangeError('The routing zoom must be a safe integer between 0 and 22.');
    }
    if (!Number.isSafeInteger(maxCellFanout) || maxCellFanout < 1 || maxCellFanout > 256) {
      throw new RangeError('The routing cell fan-out limit must be between 1 and 256.');
    }

    this.routingZoom = routingZoom;
    this.maxCellFanout = maxCellFanout;
    this.regions = (regions || []).map((region) => {
      const segments = regionSegments(region.bounds);
      if (!segments.length) {
        throw new Error(`Region ${region.id || region.asset || 'unknown'} has no routable bounds.`);
      }
      return { ...region, segments };
    }).sort(compareRegions);
    this.cells = new Map();

    for (const region of this.regions) {
      for (const [west, south, east, north] of region.segments) {
        const minX = longitudeToTileX(west, routingZoom);
        const maxX = longitudeToTileX(
          east === 180 ? 180 : Math.max(west, east - 1e-10),
          routingZoom
        );
        const minY = latitudeToTileY(north, routingZoom);
        const maxY = latitudeToTileY(south, routingZoom);

        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) {
            const key = cellKey(x, y);
            const entries = this.cells.get(key) || [];
            if (!entries.includes(region)) entries.push(region);
            if (entries.length > this.maxCellFanout) {
              throw new Error(
                `Routing cell ${key} exceeds the ${this.maxCellFanout}-region fan-out limit.`
              );
            }
            entries.sort(compareRegions);
            this.cells.set(key, entries);
          }
        }
      }
    }
  }

  regionsForTile(zoom, x, y) {
    const coordinates = normalizeTileCoordinates(zoom, x, y, 22);
    if (!coordinates) return [];
    const bounds = tileBounds(coordinates.z, coordinates.x, coordinates.y);
    let candidates = this.regions;

    if (coordinates.z >= this.routingZoom) {
      const divisor = 2 ** (coordinates.z - this.routingZoom);
      const cellX = Math.floor(coordinates.x / divisor);
      const cellY = Math.floor(coordinates.y / divisor);
      candidates = this.cells.get(cellKey(cellX, cellY)) || [];
    }

    return candidates
      .filter((region) => region.segments.some((segment) => intersects(segment, bounds)))
      .sort(compareRegions);
  }
}
