import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(process.env.OCCUMED_PREVIEW_OUTPUT || 'visual-validation/fresno-world-final');
await fs.mkdir(outputDir, { recursive: true });

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
  const [west, south, east, north] = bounds.map(Number);
  const width = west <= east ? east - west : 360 - west + east;
  return Math.max(width, 0) * Math.max(north - south, 0);
}

function selectRegion(regions, longitude, latitude) {
  return regions
    .filter((region) => containsCoordinate(region.bounds, longitude, latitude))
    .sort((left, right) => boundsArea(left.bounds) - boundsArea(right.bounds))[0] || null;
}

const manifestResponse = await fetch(`${origin}/world-manifest.json`, {
  headers: { 'Cache-Control': 'no-cache' }
});
if (!manifestResponse.ok) {
  throw new Error(`Worldwide manifest proxy failed with ${manifestResponse.status}.`);
}
const manifest = await manifestResponse.json();
if (!Array.isArray(manifest.regions) || !manifest.regions.length) {
  throw new Error('Worldwide manifest contains no regions.');
}
if (Number(manifest.missingRegionCount) !== 0) {
  throw new Error(`Worldwide manifest still reports ${manifest.missingRegionCount} missing regions.`);
}

const rangeChecks = new Map();
async function verifyRange(asset) {
  if (rangeChecks.has(asset)) return rangeChecks.get(asset);
  const response = await fetch(`${origin}/world-tiles/${encodeURIComponent(asset)}`, {
    headers: { Range: 'bytes=0-126' },
    redirect: 'follow'
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const magic = new TextDecoder().decode(bytes.slice(0, 7));
  const result = {
    asset,
    status: response.status,
    returnedBytes: bytes.length,
    magic,
    contentRange: response.headers.get('content-range')
  };
  if (response.status !== 206 || bytes.length !== 127 || magic !== 'PMTiles') {
    throw new Error(`Runtime range proxy failed for ${asset}: ${JSON.stringify(result)}`);
  }
  rangeChecks.set(asset, result);
  return result;
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: 'dark'
  });
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const networkFailures = [];

  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    networkFailures.push({
      type: 'requestfailed',
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText || 'unknown request failure'
    });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    networkFailures.push({
      type: 'http',
      url: response.url(),
      method: response.request().method(),
      status: response.status()
    });
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => globalThis.__OCCUMED_MAP__ && globalThis.__OCCUMED_MAP__.isStyleLoaded(),
    null,
    { timeout: 90_000 }
  );

  async function capture(name, center, zoom) {
    const expectedRegion = selectRegion(manifest.regions, center[0], center[1]);
    if (!expectedRegion) throw new Error(`${name} has no worldwide shard in the manifest.`);
    await verifyRange(expectedRegion.asset);

    await page.evaluate(
      ({ nextCenter, nextZoom }) => {
        const map = globalThis.__OCCUMED_MAP__;
        map.jumpTo({ center: nextCenter, zoom: nextZoom, pitch: 0, bearing: 0 });
        map.triggerRepaint();
      },
      { nextCenter: center, nextZoom: zoom }
    );

    await page.waitForFunction(
      ({ expectedAsset }) => {
        const map = globalThis.__OCCUMED_MAP__;
        const source = map?.getStyle()?.sources?.['occumed-open'];
        if (
          !map?.isStyleLoaded() ||
          typeof source?.url !== 'string' ||
          !source.url.startsWith('pmtiles://') ||
          !source.url.includes(`/world-tiles/${expectedAsset}`)
        ) {
          return false;
        }

        try {
          return map.queryRenderedFeatures().some((feature) => feature.source === 'occumed-open');
        } catch {
          return false;
        }
      },
      { expectedAsset: expectedRegion.asset },
      { timeout: 90_000 }
    );

    await page.waitForTimeout(750);

    const view = await page.evaluate(() => {
      const map = globalThis.__OCCUMED_MAP__;
      const canvas = map.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const source = map.getStyle().sources?.['occumed-open'] || null;
      const renderedWorldFeatureCount = map
        .queryRenderedFeatures()
        .filter((feature) => feature.source === 'occumed-open')
        .length;
      return {
        center: map.getCenter().toArray(),
        zoom: map.getZoom(),
        source,
        styleLoaded: map.isStyleLoaded(),
        worldSourceLoadedDiagnostic: map.isSourceLoaded('occumed-open'),
        allSourcesLoadedDiagnostic: map.areTilesLoaded(),
        renderedWorldFeatureCount,
        canvas: {
          cssWidth: rect.width,
          cssHeight: rect.height,
          backingWidth: canvas.width,
          backingHeight: canvas.height,
          effectivePixelRatio: rect.width ? canvas.width / rect.width : null
        },
        visibleLayers: map
          .getStyle()
          .layers.filter((layer) => map.getLayoutProperty(layer.id, 'visibility') !== 'none')
          .map((layer) => layer.id)
      };
    });

    if (view.canvas.effectivePixelRatio < 1.9) {
      throw new Error(`${name} rendered below the required 2x effective pixel ratio.`);
    }
    if (!view.styleLoaded || view.renderedWorldFeatureCount <= 0) {
      throw new Error(`${name} did not render features from the selected worldwide PMTiles shard.`);
    }
    if (
      typeof view.source?.url !== 'string' ||
      !view.source.url.includes(`/world-tiles/${expectedRegion.asset}`)
    ) {
      throw new Error(`${name} rendered from the wrong worldwide PMTiles shard.`);
    }

    const screenshot = await page.screenshot({
      path: path.join(outputDir, `${name}.png`),
      fullPage: false
    });
    if (screenshot.length < 25_000) {
      throw new Error(`${name} produced an unexpectedly empty browser render.`);
    }

    return { ...view, screenshotBytes: screenshot.length, expectedRegion };
  }

  const views = {
    fresnoRegional: await capture('fresno-regional-z8', [-119.55, 36.75], 8),
    fresnoCity: await capture('fresno-city-z11', [-119.7871, 36.7378], 11),
    fresnoStreet: await capture('fresno-street-z14', [-119.7871, 36.7378], 14),
    sierraTerrain: await capture('sierra-terrain-z10', [-118.85, 36.85], 10)
  };

  const allowedFailure = (entry) => {
    const url = entry.url || entry.text || '';
    const error = entry.error || '';
    return /\/favicon\.ico(?:$|\?)/i.test(url) || /ERR_ABORTED/i.test(error);
  };
  const consoleFailures = consoleMessages.filter(
    (entry) => entry.type === 'error' || /failed|error|404|416/i.test(entry.text)
  );
  const unexpectedNetworkFailures = networkFailures.filter((entry) => !allowedFailure(entry));
  const unexpectedConsoleFailures = consoleFailures.filter((entry) => !allowedFailure(entry));

  const report = {
    generatedAt: new Date().toISOString(),
    origin,
    browser: 'chromium',
    mode: 'worldwide-pinned-manifest-through-runtime-proxy',
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 2 },
    manifest: {
      plannedRegionCount: manifest.plannedRegionCount,
      availableRegionCount: manifest.availableRegionCount,
      missingRegionCount: manifest.missingRegionCount,
      regionCount: manifest.regions.length
    },
    rangeChecks: [...rangeChecks.values()],
    views,
    pageErrors,
    networkFailures,
    consoleFailures,
    unexpectedNetworkFailures,
    unexpectedConsoleFailures,
    passed: pageErrors.length === 0 && unexpectedNetworkFailures.length === 0 && unexpectedConsoleFailures.length === 0
  };

  await fs.writeFile(path.join(outputDir, 'final-world-fresno-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  if (!report.passed) {
    throw new Error(`Worldwide Fresno browser validation failed: ${JSON.stringify({
      pageErrors,
      unexpectedNetworkFailures,
      unexpectedConsoleFailures
    })}`);
  }

  console.log(`Validated ${Object.keys(views).length} high-DPI Fresno/Sierra views against the completed worldwide PMTiles release.`);
} finally {
  await browser.close();
}
