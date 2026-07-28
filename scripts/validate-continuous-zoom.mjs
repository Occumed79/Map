import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(
  process.env.OCCUMED_PREVIEW_OUTPUT || 'visual-validation/continuous-motion'
);
await fs.mkdir(outputDir, { recursive: true });

const expectedTemplate = `${origin}/tiles/{z}/{x}/{y}.pbf`;
const reportPath = path.join(outputDir, 'continuous-motion-report.json');
const report = {
  generatedAt: new Date().toISOString(),
  origin,
  expectedTemplate,
  motions: [],
  tileRequests: null,
  pageErrors: [],
  networkFailures: [],
  abortedTileRequests: [],
  externalVectorRequests: [],
  fatalError: null,
  passed: false
};

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || null
  };
}

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (seen.has(entry)) return `[Circular:${entry.constructor?.name || 'Object'}]`;
    seen.add(entry);
    if (
      !Array.isArray(entry) &&
      Object.getPrototypeOf(entry) !== Object.prototype &&
      Object.getPrototypeOf(entry) !== null
    ) {
      return `[NonPlain:${entry.constructor?.name || 'Object'}]`;
    }
    return entry;
  }, 2);
}

async function persistReport() {
  report.externalVectorRequests = [...new Set(report.externalVectorRequests)];
  await fs.writeFile(reportPath, `${safeStringify(report)}\n`);
}

function normalizeMotion(result, definition) {
  return {
    name: String(result?.name || definition.name),
    requiredLayers: [...definition.requiredLayers],
    sampleCount: Number(result?.sampleCount || 0),
    sourceChanged: Boolean(result?.sourceChanged),
    blankSampleCount: Number(result?.blankSampleCount || 0),
    missingFoundationSampleCount: Number(result?.missingFoundationSampleCount || 0),
    firstMissingFoundationSamples: Array.isArray(result?.firstMissingFoundationSamples)
      ? result.firstMissingFoundationSamples
      : [],
    longestBlankRun: Number(result?.longestBlankRun || 0),
    minimumFeatureCount: Number(result?.minimumFeatureCount || 0),
    maximumFeatureCount: Number(result?.maximumFeatureCount || 0),
    samples: Array.isArray(result?.samples) ? result.samples : [],
    executionError: null
  };
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: 'dark'
  });
  const page = await context.newPage();
  const tileStartedAt = new Map();
  const tileDurations = [];

  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (/\.pbf(?:$|\?)/i.test(url)) {
      tileStartedAt.set(request, performance.now());
      if (!url.startsWith(`${origin}/tiles/`)) report.externalVectorRequests.push(url);
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const error = request.failure()?.errorText || 'unknown request failure';
    tileStartedAt.delete(request);
    if (url.startsWith(`${origin}/tiles/`) && error === 'net::ERR_ABORTED') {
      report.abortedTileRequests.push(url);
      return;
    }
    report.networkFailures.push({ type: 'requestfailed', url, error });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      report.networkFailures.push({
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

  async function waitForStableView(center, zoom, requiredLayers) {
    await page.evaluate(async ({ center, zoom, requiredLayers }) => {
      const map = globalThis.__OCCUMED_MAP__;
      map.jumpTo({ center, zoom, pitch: 0, bearing: 0 });
      map.triggerRepaint();

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`The source did not become idle with ${requiredLayers.join(', ')} rendered.`));
        }, 90_000);
        const interval = setInterval(check, 100);

        function renderedLayersPresent() {
          const rendered = map
            .queryRenderedFeatures()
            .filter((feature) => feature.source === 'occumed-open');
          return rendered.length > 0 && requiredLayers.every((required) =>
            rendered.some((feature) => feature.sourceLayer === required)
          );
        }

        function check() {
          if (
            map.isStyleLoaded() &&
            map.areTilesLoaded() &&
            renderedLayersPresent()
          ) {
            cleanup();
            resolve();
          }
        }

        function onSourceData(event) {
          if (
            event.sourceId === 'occumed-open' &&
            event.sourceDataType === 'idle'
          ) {
            check();
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          clearInterval(interval);
          map.off('sourcedata', onSourceData);
          map.off('idle', check);
        }

        map.on('sourcedata', onSourceData);
        map.on('idle', check);
        check();
      });
    }, { center, zoom, requiredLayers });
  }

  async function runMotion(definition) {
    const { name, start, end, durationMs, requiredLayers } = definition;
    await waitForStableView(start.center, start.zoom, requiredLayers);

    const raw = await page.evaluate(async ({
      name,
      end,
      durationMs,
      expectedTemplate,
      requiredLayers
    }) => {
      const map = globalThis.__OCCUMED_MAP__;
      const samples = [];
      let sourceChanged = false;
      const expectedSignature = JSON.stringify({ url: null, tiles: [expectedTemplate] });

      const sample = () => {
        const timestamp = performance.now();
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
          zoom: Number(map.getZoom()),
          center: map.getCenter().toArray().map(Number),
          vectorFeatureCount: rendered.length,
          requiredLayerCounts: Object.fromEntries(
            requiredLayers.map((layer) => [layer, sourceLayers[layer] || 0])
          ),
          sourceLayers,
          tilesLoaded: Boolean(map.areTilesLoaded()),
          sourceSignature: signature
        });
      };

      return await new Promise((resolve, reject) => {
        const sampleTimer = setInterval(sample, 50);
        const timeout = setTimeout(() => {
          clearInterval(sampleTimer);
          map.off('moveend', finish);
          reject(new Error(`${name} motion timed out.`));
        }, durationMs + 35_000);

        const finish = () => {
          clearTimeout(timeout);
          clearInterval(sampleTimer);
          sample();
          const blankSamples = samples.filter((entry) => entry.vectorFeatureCount === 0);
          const missingFoundationSamples = samples.filter((entry) =>
            requiredLayers.some((layer) => (entry.requiredLayerCounts[layer] || 0) <= 0)
          );
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
            missingFoundationSampleCount: missingFoundationSamples.length,
            firstMissingFoundationSamples: missingFoundationSamples.slice(0, 20),
            longestBlankRun,
            minimumFeatureCount: samples.length
              ? Math.min(...samples.map((entry) => entry.vectorFeatureCount))
              : 0,
            maximumFeatureCount: samples.length
              ? Math.max(...samples.map((entry) => entry.vectorFeatureCount))
              : 0,
            samples
          });
        };

        sample();
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
    }, { name, end, durationMs, expectedTemplate, requiredLayers });

    const result = normalizeMotion(raw, definition);
    await page.screenshot({
      path: path.join(outputDir, `${name}-final.png`),
      fullPage: false
    });
    report.motions.push(result);
    await persistReport();
    return result;
  }

  const definitions = [
    {
      name: 'world-to-fresno',
      start: { center: [-98.5, 25], zoom: 2.43 },
      end: { center: [-119.7871, 36.7378], zoom: 16 },
      durationMs: 14_000,
      requiredLayers: ['land', 'landcover']
    },
    {
      name: 'fresno-to-world',
      start: { center: [-119.7871, 36.7378], zoom: 16 },
      end: { center: [-98.5, 25], zoom: 1.65 },
      durationMs: 14_000,
      requiredLayers: ['land', 'landcover']
    },
    {
      name: 'cross-border-pan',
      start: { center: [-112.5, 31.8], zoom: 7 },
      end: { center: [-101.5, 31.8], zoom: 7 },
      durationMs: 9_000,
      requiredLayers: ['land', 'landcover']
    },
    {
      name: 'europe-shard-pan',
      start: { center: [-4, 50], zoom: 6.5 },
      end: { center: [24, 50], zoom: 6.5 },
      durationMs: 10_000,
      requiredLayers: ['land', 'landcover']
    },
    {
      name: 'antimeridian-pan',
      start: { center: [168, 0], zoom: 6.5 },
      end: { center: [-168, 0], zoom: 6.5 },
      durationMs: 10_000,
      requiredLayers: ['depth']
    },
    {
      name: 'amazon-routing-threshold-in',
      start: { center: [-60, -8], zoom: 5.7 },
      end: { center: [-60, -8], zoom: 6.3 },
      durationMs: 8_000,
      requiredLayers: ['land', 'landcover']
    },
    {
      name: 'amazon-routing-threshold-out',
      start: { center: [-60, -8], zoom: 6.3 },
      end: { center: [-60, -8], zoom: 5.7 },
      durationMs: 8_000,
      requiredLayers: ['land', 'landcover']
    },
    {
      name: 'pacific-routing-threshold-in',
      start: { center: [-140, 0], zoom: 5.7 },
      end: { center: [-140, 0], zoom: 6.3 },
      durationMs: 8_000,
      requiredLayers: ['depth']
    }
  ];

  for (const definition of definitions) {
    try {
      await runMotion(definition);
    } catch (error) {
      report.motions.push({
        name: definition.name,
        requiredLayers: [...definition.requiredLayers],
        sampleCount: 0,
        sourceChanged: false,
        blankSampleCount: 0,
        missingFoundationSampleCount: 0,
        firstMissingFoundationSamples: [],
        longestBlankRun: 0,
        minimumFeatureCount: 0,
        maximumFeatureCount: 0,
        samples: [],
        executionError: serializeError(error)
      });
      await page.screenshot({
        path: path.join(outputDir, `${definition.name}-error.png`),
        fullPage: false
      }).catch(() => {});
      await persistReport();
    }
  }

  const sortedDurations = tileDurations
    .map((entry) => entry.durationMs)
    .sort((left, right) => left - right);
  const percentile = (fraction) => sortedDurations.length
    ? sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * fraction))]
    : null;

  report.tileRequests = {
    count: tileDurations.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maximumMs: sortedDurations.at(-1) || null,
    abortedCount: report.abortedTileRequests.length,
    slowest: [...tileDurations]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 30)
  };

  const failedMotions = report.motions.filter((motion) =>
    motion.executionError ||
    motion.sourceChanged ||
    motion.blankSampleCount > 0 ||
    motion.missingFoundationSampleCount > 0 ||
    motion.sampleCount < 20
  );
  report.externalVectorRequests = [...new Set(report.externalVectorRequests)];
  report.passed =
    failedMotions.length === 0 &&
    report.pageErrors.length === 0 &&
    report.networkFailures.length === 0 &&
    report.externalVectorRequests.length === 0;
  await persistReport();

  if (!report.passed) {
    throw new Error(`Continuous motion validation failed: ${safeStringify({
      failedMotions,
      pageErrors: report.pageErrors,
      networkFailures: report.networkFailures,
      abortedTileRequestCount: report.abortedTileRequests.length,
      externalVectorRequests: report.externalVectorRequests
    })}`);
  }

  console.log(
    `Validated ${definitions.length} continuous motions with 50ms sampling, no blank frames, no missing physical foundation, and ${report.abortedTileRequests.length} expected canceled tile requests; tile p95 ${Math.round(report.tileRequests.p95Ms || 0)}ms.`
  );
} catch (error) {
  report.fatalError = serializeError(error);
  report.passed = false;
  await persistReport().catch(() => {});
  throw error;
} finally {
  await browser?.close();
}
