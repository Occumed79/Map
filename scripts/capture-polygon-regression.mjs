import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(
  process.env.OCCUMED_PREVIEW_OUTPUT || 'visual-validation/polygon-regression'
);
await fs.mkdir(outputDir, { recursive: true });

const expectedTemplate = `${origin}/tiles/{z}/{x}/{y}.pbf`;
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: 'dark'
  });
  const page = await context.newPage();
  const pageErrors = [];
  const networkFailures = [];
  const externalVectorRequests = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (/\.pbf(?:$|\?)/i.test(url) && !url.startsWith(`${origin}/tiles/`)) {
      externalVectorRequests.push(url);
    }
  });
  page.on('requestfailed', (request) => {
    networkFailures.push({
      type: 'requestfailed',
      url: request.url(),
      error: request.failure()?.errorText || 'unknown request failure'
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      networkFailures.push({
        type: 'http',
        url: response.url(),
        status: response.status()
      });
    }
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => globalThis.__OCCUMED_MAP__?.isStyleLoaded(),
    null,
    { timeout: 90_000 }
  );

  const continuityZooms = [1.65, 2.43, 3.5, 5.5, 6.5];
  const views = [
    { name: 'north-america-z2', center: [-102, 36], zoom: 2.43, requiresAtmosphereBloom: true },
    { name: 'central-pacific-z2', center: [175, 7], zoom: 2.43, requiresAtmosphereBloom: true },
    { name: 'australia-z2', center: [135, -25], zoom: 2.43, requiresAtmosphereBloom: true },
    { name: 'asia-pacific-z2', center: [118, 22], zoom: 2.43, requiresAtmosphereBloom: true },
    { name: 'africa-europe-z2', center: [20, 20], zoom: 2.43, requiresAtmosphereBloom: true },
    { name: 'world-north-america-z1', center: [-100, 25], zoom: 1.65, requiresAtmosphereBloom: true },
    ...continuityZooms.map((zoom) => ({
      name: `amazon-z${String(zoom).replace('.', '-')}`,
      center: [-60, -8],
      zoom,
      requiredSourceLayers: ['land', 'landcover'],
      requiredRenderedLayers: ['land', 'landcover']
    })),
    ...continuityZooms.map((zoom) => ({
      name: `pacific-depth-z${String(zoom).replace('.', '-')}`,
      center: [-140, 0],
      zoom,
      requiredSourceLayers: ['depth'],
      requiredRenderedLayers: ['depth']
    }))
  ];
  const results = {};

  for (const view of views) {
    await page.evaluate(({ center, zoom }) => {
      const map = globalThis.__OCCUMED_MAP__;
      map.jumpTo({ center, zoom, pitch: 0, bearing: 0 });
      map.triggerRepaint();
    }, view);

    await page.waitForFunction(
      () => {
        const map = globalThis.__OCCUMED_MAP__;
        return map?.isStyleLoaded() && map.areTilesLoaded() &&
          map.queryRenderedFeatures().some((feature) => feature.source === 'occumed-open');
      },
      null,
      { timeout: 90_000 }
    );
    await page.waitForTimeout(500);

    const diagnostics = await page.evaluate((expectedTemplate) => {
      const map = globalThis.__OCCUMED_MAP__;
      const source = map.getStyle().sources?.['occumed-open'] || null;
      const features = map
        .queryRenderedFeatures()
        .filter((feature) => feature.source === 'occumed-open');
      const renderedSourceLayerCounts = {};
      const styleLayerCounts = {};
      for (const feature of features) {
        const sourceLayer = feature.sourceLayer || 'unknown';
        const styleLayer = feature.layer?.id || 'unknown';
        renderedSourceLayerCounts[sourceLayer] = (renderedSourceLayerCounts[sourceLayer] || 0) + 1;
        styleLayerCounts[styleLayer] = (styleLayerCounts[styleLayer] || 0) + 1;
      }
      const sourceFeatureCounts = Object.fromEntries(
        ['land', 'landcover', 'depth'].map((sourceLayer) => [
          sourceLayer,
          map.querySourceFeatures('occumed-open', { sourceLayer }).length
        ])
      );
      const bloom = document.querySelector('.occumed-atmosphere-bloom');
      const bloomStyle = bloom ? getComputedStyle(bloom) : null;
      const bloomRect = bloom?.getBoundingClientRect() || null;
      return {
        center: map.getCenter().toArray(),
        zoom: map.getZoom(),
        source,
        sourceIsPermanent:
          !source?.url && JSON.stringify(source?.tiles || []) === JSON.stringify([expectedTemplate]),
        renderedFeatureCount: features.length,
        renderedSourceLayerCounts,
        sourceFeatureCounts,
        styleLayerCounts,
        atmosphereBloom: {
          exists: Boolean(bloom),
          hidden: Boolean(bloom?.hidden),
          opacity: Number(bloomStyle?.opacity || 0),
          filter: bloomStyle?.filter || 'none',
          mixBlendMode: bloomStyle?.mixBlendMode || 'normal',
          width: bloomRect?.width || 0,
          height: bloomRect?.height || 0
        }
      };
    }, expectedTemplate);

    if (!diagnostics.sourceIsPermanent) {
      throw new Error(`${view.name} changed the permanent vector source.`);
    }
    if (diagnostics.renderedFeatureCount <= 0) {
      throw new Error(`${view.name} rendered no worldwide vector features.`);
    }
    for (const sourceLayer of view.requiredSourceLayers || []) {
      if ((diagnostics.sourceFeatureCounts[sourceLayer] || 0) <= 0) {
        throw new Error(`${view.name} lost the ${sourceLayer} source layer at zoom ${view.zoom}.`);
      }
    }
    for (const sourceLayer of view.requiredRenderedLayers || []) {
      if ((diagnostics.renderedSourceLayerCounts[sourceLayer] || 0) <= 0) {
        throw new Error(`${view.name} stopped rendering the ${sourceLayer} foundation at zoom ${view.zoom}.`);
      }
    }
    if (view.requiresAtmosphereBloom) {
      const bloom = diagnostics.atmosphereBloom;
      if (!bloom.exists || bloom.hidden || bloom.opacity < 0.95) {
        throw new Error(`${view.name} does not show the full-strength globe atmosphere bloom.`);
      }
      if (bloom.filter === 'none' || bloom.mixBlendMode !== 'screen') {
        throw new Error(`${view.name} has a hard rim instead of the luminous white-blue bloom.`);
      }
      if (bloom.width < 150 || Math.abs(bloom.width - bloom.height) > 1) {
        throw new Error(`${view.name} atmosphere bloom does not track the rendered globe.`);
      }
    }

    const screenshot = await page.screenshot({
      path: path.join(outputDir, `${view.name}.png`),
      fullPage: false
    });
    if (screenshot.length < 25_000) {
      throw new Error(`${view.name} produced an unexpectedly empty screenshot.`);
    }
    results[view.name] = { ...diagnostics, screenshotBytes: screenshot.length };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    origin,
    mode: 'rebuilt-overview-polygon-layer-continuity-and-atmosphere-regression',
    expectedTemplate,
    continuityZooms,
    results,
    pageErrors,
    networkFailures,
    externalVectorRequests: [...new Set(externalVectorRequests)],
    passed:
      pageErrors.length === 0 &&
      networkFailures.length === 0 &&
      externalVectorRequests.length === 0
  };

  await fs.writeFile(
    path.join(outputDir, 'polygon-regression-report.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );

  if (!report.passed) {
    throw new Error(`Polygon, layer continuity, and atmosphere validation failed: ${JSON.stringify({
      pageErrors,
      networkFailures,
      externalVectorRequests: report.externalVectorRequests
    })}`);
  }

  console.log(
    `Rendered ${views.length} rebuilt-overview views with continuous physical layers and a tracked exterior atmosphere bloom.`
  );
} finally {
  await browser.close();
}
