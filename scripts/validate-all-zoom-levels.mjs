import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(
  process.env.OCCUMED_PREVIEW_OUTPUT || 'visual-validation/all-zoom-levels'
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
      networkFailures.push({ type: 'http', url: response.url(), status: response.status() });
    }
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => globalThis.__OCCUMED_MAP__?.isStyleLoaded(),
    null,
    { timeout: 90_000 }
  );

  async function runSweep(name, center, startZoom, endZoom) {
    await page.evaluate(({ center, startZoom }) => {
      const map = globalThis.__OCCUMED_MAP__;
      map.jumpTo({ center, zoom: startZoom, pitch: 0, bearing: 0 });
      map.triggerRepaint();
    }, { center, startZoom });

    await page.waitForFunction(
      () => {
        const map = globalThis.__OCCUMED_MAP__;
        return map?.isStyleLoaded() &&
          map.queryRenderedFeatures().some((feature) => feature.source === 'occumed-open');
      },
      null,
      { timeout: 90_000 }
    );

    const result = await page.evaluate(async ({
      name,
      center,
      startZoom,
      endZoom,
      expectedTemplate
    }) => {
      const map = globalThis.__OCCUMED_MAP__;
      const samples = [];
      let lastSampleAt = -Infinity;
      let sourceChanged = false;
      const expectedSignature = JSON.stringify({ url: null, tiles: [expectedTemplate] });

      const sample = (timestamp) => {
        if (timestamp - lastSampleAt < 50) return;
        lastSampleAt = timestamp;
        const source = map.getStyle().sources?.['occumed-open'] || null;
        const signature = JSON.stringify({ url: source?.url || null, tiles: source?.tiles || [] });
        sourceChanged ||= signature !== expectedSignature;
        const rendered = map
          .queryRenderedFeatures()
          .filter((feature) => feature.source === 'occumed-open');
        const sourceLayers = {};
        for (const feature of rendered) {
          const layer = feature.sourceLayer || 'unknown';
          sourceLayers[layer] = (sourceLayers[layer] || 0) + 1;
        }
        samples.push({
          timestamp,
          zoom: map.getZoom(),
          renderedFeatureCount: rendered.length,
          sourceLayers,
          sourceSignature: signature
        });
      };

      return await new Promise((resolve, reject) => {
        const durationMs = 18_000;
        const timeout = setTimeout(() => {
          map.off('render', sample);
          reject(new Error(`${name} full-range zoom sweep timed out.`));
        }, durationMs + 30_000);

        const finish = () => {
          clearTimeout(timeout);
          map.off('render', sample);
          sample(performance.now());
          const zooms = samples.map((entry) => entry.zoom).sort((a, b) => a - b);
          let maximumZoomGap = 0;
          for (let index = 1; index < zooms.length; index += 1) {
            maximumZoomGap = Math.max(maximumZoomGap, zooms[index] - zooms[index - 1]);
          }
          const blankSamples = samples.filter((entry) => entry.renderedFeatureCount === 0);
          resolve({
            name,
            center,
            startZoom,
            endZoom,
            sampleCount: samples.length,
            sourceChanged,
            blankSampleCount: blankSamples.length,
            minimumZoom: Math.min(...zooms),
            maximumZoom: Math.max(...zooms),
            maximumZoomGap,
            minimumFeatureCount: Math.min(...samples.map((entry) => entry.renderedFeatureCount)),
            samples
          });
        };

        map.on('render', sample);
        map.once('moveend', finish);
        map.easeTo({
          center,
          zoom: endZoom,
          pitch: 0,
          bearing: 0,
          duration: durationMs,
          easing: (value) => value,
          essential: true
        });
      });
    }, { name, center, startZoom, endZoom, expectedTemplate });

    await page.screenshot({
      path: path.join(outputDir, `${name}-final.png`),
      fullPage: false
    });
    return result;
  }

  const sweeps = [
    await runSweep('amazon-all-zooms-in', [-62.5, -4], 0, 14),
    await runSweep('hawaii-all-zooms-out', [-157.8583, 21.3069], 14, 0)
  ];

  const failedSweeps = sweeps.filter((sweep) =>
    sweep.sourceChanged ||
    sweep.blankSampleCount > 0 ||
    sweep.sampleCount < 100 ||
    sweep.minimumZoom > 0.1 ||
    sweep.maximumZoom < 13.9 ||
    sweep.maximumZoomGap > 0.25
  );

  const report = {
    generatedAt: new Date().toISOString(),
    origin,
    expectedTemplate,
    sweeps,
    pageErrors,
    networkFailures,
    externalVectorRequests: [...new Set(externalVectorRequests)],
    passed:
      failedSweeps.length === 0 &&
      pageErrors.length === 0 &&
      networkFailures.length === 0 &&
      externalVectorRequests.length === 0
  };

  await fs.writeFile(
    path.join(outputDir, 'all-zoom-levels-report.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );

  if (!report.passed) {
    throw new Error(`All-zoom validation failed: ${JSON.stringify({
      failedSweeps: failedSweeps.map((sweep) => ({
        name: sweep.name,
        sampleCount: sweep.sampleCount,
        sourceChanged: sweep.sourceChanged,
        blankSampleCount: sweep.blankSampleCount,
        minimumZoom: sweep.minimumZoom,
        maximumZoom: sweep.maximumZoom,
        maximumZoomGap: sweep.maximumZoomGap,
        minimumFeatureCount: sweep.minimumFeatureCount
      })),
      pageErrors,
      networkFailures,
      externalVectorRequests: report.externalVectorRequests
    })}`);
  }

  console.log(
    `Validated the complete zoom 0–14 range in both directions with ${sweeps.reduce((sum, sweep) => sum + sweep.sampleCount, 0)} sampled frames and zero blank frames.`
  );
} finally {
  await browser.close();
}
