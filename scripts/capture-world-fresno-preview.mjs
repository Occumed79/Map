import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(
  process.env.OCCUMED_PREVIEW_OUTPUT || 'visual-validation/continuous-world-final'
);
await fs.mkdir(outputDir, { recursive: true });

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
  const vectorRequests = [];
  const forbiddenRequests = [];

  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (/openfreemap|\/world-tiles\/|\/world-manifest\.json/i.test(url)) {
      forbiddenRequests.push(url);
    }
    if (/\.pbf(?:$|\?)/i.test(url)) vectorRequests.push(url);
  });
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

  const initialSource = await page.evaluate(() => {
    return globalThis.__OCCUMED_MAP__.getStyle().sources?.['occumed-open'] || null;
  });
  const expectedTemplate = `${origin}/tiles/{z}/{x}/{y}.pbf`;
  if (
    initialSource?.url ||
    JSON.stringify(initialSource?.tiles || []) !== JSON.stringify([expectedTemplate])
  ) {
    throw new Error(`The browser source is not permanent: ${JSON.stringify(initialSource)}`);
  }

  async function capture(name, center, zoom) {
    await page.evaluate(
      ({ nextCenter, nextZoom }) => {
        const map = globalThis.__OCCUMED_MAP__;
        map.jumpTo({ center: nextCenter, zoom: nextZoom, pitch: 0, bearing: 0 });
        map.triggerRepaint();
      },
      { nextCenter: center, nextZoom: zoom }
    );

    await page.waitForFunction(
      () => {
        const map = globalThis.__OCCUMED_MAP__;
        return map?.isStyleLoaded() && map.areTilesLoaded();
      },
      null,
      { timeout: 90_000 }
    );
    await page.waitForTimeout(300);

    const view = await page.evaluate(() => {
      const map = globalThis.__OCCUMED_MAP__;
      const canvas = map.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const source = map.getStyle().sources?.['occumed-open'] || null;
      const features = map
        .queryRenderedFeatures()
        .filter((feature) => feature.source === 'occumed-open');
      const styleLayerCounts = {};
      for (const feature of features) {
        const id = feature.layer?.id || 'unknown';
        styleLayerCounts[id] = (styleLayerCounts[id] || 0) + 1;
      }
      return {
        center: map.getCenter().toArray(),
        zoom: map.getZoom(),
        source,
        styleLoaded: map.isStyleLoaded(),
        allTilesLoaded: map.areTilesLoaded(),
        renderedWorldFeatureCount: features.length,
        renderedSourceLayers: [...new Set(features.map((feature) => feature.sourceLayer))].sort(),
        renderedStyleLayerCounts: Object.fromEntries(
          Object.entries(styleLayerCounts).sort((left, right) => right[1] - left[1])
        ),
        canvas: {
          cssWidth: rect.width,
          cssHeight: rect.height,
          backingWidth: canvas.width,
          backingHeight: canvas.height,
          effectivePixelRatio: rect.width ? canvas.width / rect.width : null
        }
      };
    });

    const screenshot = await page.screenshot({
      path: path.join(outputDir, `${name}.png`),
      fullPage: false
    });
    const diagnostics = {
      ...view,
      screenshotBytes: screenshot.length,
      pageErrors: [...pageErrors],
      networkFailures: networkFailures.slice(-30),
      consoleMessages: consoleMessages.slice(-50)
    };

    if (view.canvas.effectivePixelRatio < 1.9) {
      await fs.writeFile(
        path.join(outputDir, `${name}-failure.json`),
        `${JSON.stringify(diagnostics, null, 2)}\n`
      );
      throw new Error(`${name} rendered below the required 2x effective pixel ratio.`);
    }
    if (view.renderedWorldFeatureCount <= 0) {
      await fs.writeFile(
        path.join(outputDir, `${name}-failure.json`),
        `${JSON.stringify(diagnostics, null, 2)}\n`
      );
      throw new Error(
        `${name} did not render a completed worldwide vector view: ${JSON.stringify({
          styleLoaded: view.styleLoaded,
          allTilesLoaded: view.allTilesLoaded,
          renderedWorldFeatureCount: view.renderedWorldFeatureCount,
          renderedSourceLayers: view.renderedSourceLayers,
          networkFailures: networkFailures.slice(-5)
        })}`
      );
    }
    if (
      view.source?.url ||
      JSON.stringify(view.source?.tiles || []) !== JSON.stringify([expectedTemplate])
    ) {
      await fs.writeFile(
        path.join(outputDir, `${name}-failure.json`),
        `${JSON.stringify(diagnostics, null, 2)}\n`
      );
      throw new Error(`${name} changed the permanent vector source.`);
    }

    if (screenshot.length < 25_000) {
      await fs.writeFile(
        path.join(outputDir, `${name}-failure.json`),
        `${JSON.stringify(diagnostics, null, 2)}\n`
      );
      throw new Error(`${name} produced an unexpectedly empty browser render.`);
    }
    return { ...view, screenshotBytes: screenshot.length };
  }

  const views = {
    globe: await capture('world-globe-z2', [28, 41], 2.43),
    northAmerica: await capture('north-america-z4', [-105, 40], 4),
    usMexico: await capture('us-mexico-border-z7', [-106.5, 31.8], 7),
    europe: await capture('europe-boundaries-z6', [12, 50], 6),
    antimeridian: await capture('russia-antimeridian-z5', [178, 60], 5),
    southeastAsia: await capture('southeast-asia-z4', [115, 7], 4),
    sydneyRegional: await capture('sydney-regional-z8', [150.6, -33.7], 8.39),
    sydneyStreet: await capture('sydney-street-z10', [151.056, -33.787], 10.22),
    fresnoCity: await capture('fresno-city-z11', [-119.7871, 36.7378], 11),
    fresnoStreet: await capture('fresno-street-z14', [-119.7871, 36.7378], 14)
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
  const externalVectorRequests = vectorRequests.filter(
    (url) => !url.startsWith(`${origin}/tiles/`)
  );

  const report = {
    generatedAt: new Date().toISOString(),
    origin,
    browser: 'chromium',
    mode: 'one-permanent-virtual-worldwide-source',
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 2 },
    initialSource,
    views,
    vectorRequests: [...new Set(vectorRequests)],
    externalVectorRequests,
    forbiddenRequests: [...new Set(forbiddenRequests)],
    pageErrors,
    unexpectedNetworkFailures,
    unexpectedConsoleFailures,
    passed:
      pageErrors.length === 0 &&
      unexpectedNetworkFailures.length === 0 &&
      unexpectedConsoleFailures.length === 0 &&
      externalVectorRequests.length === 0 &&
      forbiddenRequests.length === 0
  };

  await fs.writeFile(
    path.join(outputDir, 'continuous-world-report.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );

  if (!report.passed) {
    throw new Error(`Continuous-world browser validation failed: ${JSON.stringify({
      pageErrors,
      unexpectedNetworkFailures,
      unexpectedConsoleFailures,
      externalVectorRequests,
      forbiddenRequests
    })}`);
  }

  console.log(`Validated ${Object.keys(views).length} high-DPI views through one permanent worldwide source.`);
} finally {
  await browser.close();
}
