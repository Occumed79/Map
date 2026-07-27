const DEFAULT_SWITCH_ZOOM = 6;
const ROUTER_SOURCE_ID = 'occumed-open';

function normalizePmtilesUrl(url) {
  if (!url) return null;
  return url.startsWith('pmtiles://') ? url : `pmtiles://${url}`;
}

function containsCoordinate(bounds, longitude, latitude) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return false;
  const [west, south, east, north] = bounds.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return false;
  const latitudeMatch = latitude >= south && latitude <= north;
  const longitudeMatch = west <= east
    ? longitude >= west && longitude <= east
    : longitude >= west || longitude <= east;
  return latitudeMatch && longitudeMatch;
}

function boundsArea(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return Infinity;
  const [west, south, east, north] = bounds.map(Number);
  const width = west <= east ? east - west : 360 - west + east;
  return Math.max(width, 0) * Math.max(north - south, 0);
}

function selectRegion(regions, longitude, latitude) {
  return regions
    .filter((region) => containsCoordinate(region.bounds, longitude, latitude))
    .sort((left, right) => boundsArea(left.bounds) - boundsArea(right.bounds))[0] || null;
}

async function fetchManifest(manifestUrl) {
  const response = await fetch(manifestUrl, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!response.ok) throw new Error(`Unable to load worldwide PMTiles manifest (${response.status}).`);
  const manifest = await response.json();
  if (!Array.isArray(manifest.regions)) throw new Error('Worldwide PMTiles manifest is missing regions.');
  return manifest;
}

export async function installWorldPmtilesRouter(map, {
  manifestUrl,
  fallbackUrl,
  sourceId = ROUTER_SOURCE_ID
}) {
  if (!manifestUrl || !fallbackUrl) return null;

  let manifest;
  try {
    manifest = await fetchManifest(manifestUrl);
  } catch (error) {
    console.warn('Occu-Med worldwide PMTiles routing is unavailable; retaining the local empty vector source.', error);
    return null;
  }

  const switchZoom = Number.isFinite(Number(manifest.switchZoom))
    ? Number(manifest.switchZoom)
    : DEFAULT_SWITCH_ZOOM;
  let activeUrl = fallbackUrl;
  let activeRegion = null;

  const apply = () => {
    const source = map.getSource(sourceId);
    if (!source || typeof source.setUrl !== 'function') return;

    const center = map.getCenter();
    const region = map.getZoom() >= switchZoom
      ? selectRegion(manifest.regions, center.lng, center.lat)
      : null;
    const nextUrl = region ? normalizePmtilesUrl(region.url) : fallbackUrl;
    if (!nextUrl || nextUrl === activeUrl) return;

    source.setUrl(nextUrl);
    map.triggerRepaint();
    activeUrl = nextUrl;
    activeRegion = region?.id || null;
    map.fire('occumedworldsourcechange', {
      region: activeRegion,
      url: nextUrl,
      fallback: !region
    });
  };

  const scheduleApply = () => queueMicrotask(apply);
  map.on('moveend', scheduleApply);
  map.on('zoomend', scheduleApply);
  if (map.loaded()) apply();
  else map.once('load', apply);

  return {
    manifest,
    get activeRegion() {
      return activeRegion;
    },
    refresh: apply,
    destroy() {
      map.off('moveend', scheduleApply);
      map.off('zoomend', scheduleApply);
    }
  };
}
