import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(
  process.env.OCCUMED_PREVIEW_OUTPUT || 'visual-validation/continuous-motion'
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
  const tileStartedAt = new Map();
  const tileDurations = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (/\.pbf(?:$|\?)/i.test(url)) {
      tileStartedAt.set(request, performance.now());
      if (!url.startsWith(`${origin}/tiles/`)) externalVectorRequests.push(url);
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
  page.on('requestfinished', (request) => {
    const started = tileStartedAt.get(request);
    if (started === undefined) return;
    tileDurations.push({
      url: request.url(),
      durationMs: performance.now() - started
    });
    tileStartedAt.delete(request);
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => globalThis.__OCCUMED_MAP__?.isStyleLoaded(),
    null,
    { timeout: 90_000 }
  );

  async function waitForStableView(center, zoom) {
    await page.evaluate(({ center, zoom }) => {
      const map = globalThis.__OCCUMED_MAP__;
      map.jumpTo({ center, zoom, pitch: 0, bearing: 0 });
      map.triggerRepaint();
    }, { center, zoom });

    await page.waitForFunction(
      () => {
        const map = globalThis.__OCCUMED_MAP__;
        return map?.isStyleLoaded() && map.areTilesLoaded() &&
          map.queryRenderedFeatures().some((feature) => feature.source === 'occumed-open');
      },
      null,
      { timeout: 90_000 }
    );
  }

  async function runMotion(name, start, end, durationMs) {
    await waitForStableView(start.center, start.zoom);

    const result = await page.evaluate(async ({ name, end, durationMs, expectedTemplate }) => {
      const map = globalThis.__OCCUMED_MAP__;
      const samples = [];
      let lastSampleAt = -Infinity;
      let sourceChanged = false;

      const sourceSignature = () => {
        const source = map.getStyle().sources?.['occumed-open'] || null;
        return JSON.stringify({ url: source?.url || null, tiles: source?.tiles || [] });
      };
      const expectedSignature = JSON.stringify({ url: null, tiles: [expectedTemplate] });

      const sample = (timestamp) => {
        if (timestamp - lastSampleAt < 80) return;
        lastSampleAt = timestamp;
        const signature = sourceSignature();
        sourceChanged ||= signature !== expectedSignature;
        const vectorFeatureCount = map
          .queryRenderedFeatures()
          .filter((feature) => feature.source === 'occumed-open')
          .length;
        samples.push({
          timestamp,
          zoom: map.getZoom(),
          center: map.getCenter().toArray(),
          vectorFeatureCount,
          tilesLoaded: map.areTilesLoaded(),
          sourceSignature: signature
        });
      };

      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          map.off('render', sample);
          reject(new Error(`${name} motion timed out.`));
        }, durationMs + 30_000);

        const finish = () => {
          clearTimeout(timeout);
          map.off('render', sample);
          sample(performance.now());
          const blankSamples = samples.filter((entry) => entry.vectorFeatureCount === 0);
          let longestBlankRun = 0;
          let currentBlankRun = 0;
          for (const entry of samples) {
            if (entry.vectorFeatureCount === 0) {
              currentBlankRun += 1;
              longestBlankRun = Math.max(longestBlankRun, currentBlankRun);
            } else {
              currentBlankRun = 0;
            }
          }
          resolve({
            name,
            sampleCount: samples.length,
            sourceChanged,
            blankSampleCount: blankSamples.length,
            longestBlankRun,
            minimumFeatureCount: Math.min(...samples.map((entry) => entry.vectorFeatureCount)),
            maximumFeatureCount: Math.max(...samples.map((entry) => entry.vectorFeatureCount)),
            samples
          });
        };

        map.on('render', sample);
        map.once('moveend', finish);
        map.easeTo({
          center: end.center,
          zoom: end.zoom,
          pitch: 0,
          bearing: 0,
          duration: durationMs,
          easing: (value) => value,
          essential: true
        });
      });
    }, { name, end, durationMs, expectedTemplate });

    await page.screenshot({
      path: path.join(outputDir, `${name}-final.png`),
      fullPage: false
    });
    return result;
  }

  const motions = [
    await runMotion(
      'world-to-fresno',
      { center: [-98.5, 25], zoom: 2.43 },
      { center: [-119.7871, 36.7378], zoom: 14 },
      12_000
    ),
    await runMotion(
      'fresno-to-world',
      { center: [-119.7871, 36.7378], zoom: 14 },
      { center: [-98.5, 25], zoom: 2.43 },
      12_000
    ),
    await runMotion(
      'cross-border-pan',
      { center: [-112.5, 31.8], zoom: 7 },
      { center: [-101.5, 31.8], zoom: 7 },
      8_000
    ),
    await runMotion(
      'europe-shard-pan',
      { center: [-4, 50], zoom: 6.5 },
      { center: [24, 50], zoom: 6.5 },
      9_000
    )
  ];

  const sortedDurations = tileDurations
    .map((entry) => entry.durationMs)
    .sort((left, right) => left - right);
  const percentile = (fraction) => sortedDurations.length
    ? sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * fraction))]
    : null;

  const report = {
    generatedAt: new Date().toISOString(),
    origin,
    expectedTemplate,
    motions,
    tileRequests: {
      count: tileDurations.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maximumMs: sortedDurations.at(-1) || null,
      slowest: [...tileDurations]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, 20)
    },
    pageErrors,
    networkFailures,
    externalVectorRequests: [...new Set(externalVectorRequests)]
  };

  await fs.writeFile(
    path.join(outputDir, 'continuous-motion-report.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );

  const failedMotions = motions.filter(
    (motion) => motion.sourceChanged || motion.blankSampleCount > 0 || motion.sampleCount < 20
  );
  if (
    failedMotions.length ||
    pageErrors.length ||
    networkFailures.length ||
    externalVectorRequests.length
  ) {
    throw new Error(`Continuous motion validation failed: ${JSON.stringify({
      failedMotions: failedMotions.map((motion) => ({
        name: motion.name,
        sampleCount: motion.sampleCount,
        sourceChanged: motion.sourceChanged,
        blankSampleCount: motion.blankSampleCount,
        longestBlankRun: motion.longestBlankRun,
        minimumFeatureCount: motion.minimumFeatureCount
      })),
      pageErrors,
      networkFailures,
      externalVectorRequests
    })}`);
  }

  console.log(
    `Validated ${motions.length} continuous motions with zero blank vector frames; ` +
    `tile p95 ${Math.round(report.tileRequests.p95Ms || 0)}ms.`
  );
} finally {
  await browser.close();
}
