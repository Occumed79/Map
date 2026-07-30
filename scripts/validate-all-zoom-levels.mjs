import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(
  process.env.OCCUMED_PREVIEW_OUTPUT || 'visual-validation/all-zoom-levels'
);
await fs.mkdir(outputDir, { recursive: true });

const expectedTemplate = `${origin}/tiles/{z}/{x}/{y}.pbf`;
const requestedZooms = [
  0, 1, 1.5, 2, 2.43, 3, 4, 5, 5.5, 5.9, 6, 6.1, 6.5,
  7, 8, 9, 10, 11, 12, 13, 14, 15, 16
];
const reportPath = path.join(outputDir, 'all-zoom-levels-report.json');
const report = {
  generatedAt: new Date().toISOString(),
  origin,
  expectedTemplate,
  requestedZooms,
  sweeps: [],
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
    return entry;
  }, 2);
}

async function persistReport() {
  report.externalVectorRequests = [...new Set(report.externalVectorRequests)];
  await fs.writeFile(reportPath, `${safeStringify(report)}\n`);
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

  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (/\.pbf(?:$|\?)/i.test(url) && !url.startsWith(`${origin}/tiles/`)) {
      report.externalVectorRequests.push(url);
    }
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const error = request.failure()?.errorText || 'unknown request failure';
    if (url.startsWith(`${origin}/tiles/`) && error === 'net::ERR_ABORTED') {
      report.abortedTileRequests.push(url);
      return;
    }
    report.networkFailures.push({ type: 'requestfailed', url, error });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      report.networkFailures.push({ type: 'http', url: response.url(), status: response.status() });
    }
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => globalThis.__OCCUMED_MAP__?.isStyleLoaded(),
    null,
    { timeout: 90_000 }
  );
  await page.evaluate(() => globalThis.__OCCUMED_MAP__.setPixelRatio(1));

  async function validateCheckpoint(definition, requestedZoom) {
    return await page.evaluate(async ({ definition, requestedZoom, expectedTemplate }) => {
      const map = globalThis.__OCCUMED_MAP__;
      map.jumpTo({
        center: definition.center,
        zoom: requestedZoom,
        pitch: 0,
        bearing: 0
      });
      map.triggerRepaint();

      const requiredLayerCounts = () => {
        const counts = Object.fromEntries(definition.requiredLayers.map((layer) => [layer, 0]));
        for (const feature of map.queryRenderedFeatures()) {
          if (feature.source !== 'occumed-open') continue;
          const sourceLayer = feature.sourceLayer || 'unknown';
          if (Object.hasOwn(counts, sourceLayer)) counts[sourceLayer] += 1;
        }
        return counts;
      };

      await new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(
            `${definition.name} did not render ${definition.requiredLayers.join(', ')} at requested zoom ${requestedZoom}.`
          ));
        }, 30_000);
        const interval = setInterval(check, 100);

        function check() {
          const counts = requiredLayerCounts();
          if (
            map.isStyleLoaded() &&
            definition.requiredLayers.every((layer) => counts[layer] > 0)
          ) {
            cleanup();
            resolve(performance.now() - startedAt);
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          clearInterval(interval);
          map.off('render', check);
          map.off('idle', check);
          map.off('sourcedata', check);
        }

        map.on('render', check);
        map.on('idle', check);
        map.on('sourcedata', check);
        check();
      });

      const source = map.getStyle().sources?.['occumed-open'] || null;
      const sourceSignature = JSON.stringify({
        url: source?.url || null,
        tiles: source?.tiles || []
      });
      const requiredLayerCounts = {};
      let renderedFeatureCount = 0;
      for (const requiredLayer of definition.requiredLayers) requiredLayerCounts[requiredLayer] = 0;
      for (const feature of map.queryRenderedFeatures()) {
        if (feature.source !== 'occumed-open') continue;
        renderedFeatureCount += 1;
        const sourceLayer = feature.sourceLayer || 'unknown';
        if (Object.hasOwn(requiredLayerCounts, sourceLayer)) requiredLayerCounts[sourceLayer] += 1;
      }

      return {
        requestedZoom,
        actualZoom: Number(map.getZoom()),
        renderedFeatureCount,
        requiredLayerCounts,
        tilesLoaded: Boolean(map.areTilesLoaded()),
        sourceSignature,
        sourceChanged: sourceSignature !== JSON.stringify({ url: null, tiles: [expectedTemplate] })
      };
    }, { definition, requestedZoom, expectedTemplate });
  }

  const definitions = [
    { name: 'amazon-all-zooms-in', center: [-60, -8], direction: 'in', requiredLayers: ['land', 'landcover'] },
    { name: 'amazon-all-zooms-out', center: [-60, -8], direction: 'out', requiredLayers: ['land', 'landcover'] },
    { name: 'pacific-all-zooms-in', center: [-140, 0], direction: 'in', requiredLayers: ['depth'] },
    { name: 'pacific-all-zooms-out', center: [-140, 0], direction: 'out', requiredLayers: ['depth'] },
    { name: 'europe-all-zooms-in', center: [12, 50], direction: 'in', requiredLayers: ['land', 'landcover'] },
    { name: 'antimeridian-all-zooms-out', center: [179, 0], direction: 'out', requiredLayers: ['depth'] }
  ];

  for (const definition of definitions) {
    const checkpoints = [];
    const failures = [];
    const orderedZooms = definition.direction === 'out'
      ? [...requestedZooms].reverse()
      : [...requestedZooms];

    for (const requestedZoom of orderedZooms) {
      try {
        const checkpoint = await validateCheckpoint(definition, requestedZoom);
        checkpoints.push(checkpoint);
        if (checkpoint.sourceChanged) {
          failures.push(`${definition.name} changed the permanent source at zoom ${requestedZoom}.`);
        }
        if (checkpoint.renderedFeatureCount <= 0) {
          failures.push(`${definition.name} rendered a blank frame at zoom ${requestedZoom}.`);
        }
        for (const layer of definition.requiredLayers) {
          if ((checkpoint.requiredLayerCounts[layer] || 0) <= 0) {
            failures.push(`${definition.name} lost ${layer} at zoom ${requestedZoom}.`);
          }
        }
      } catch (error) {
        failures.push(error.message);
        checkpoints.push({ requestedZoom, executionError: serializeError(error) });
      }
      await persistReport();
    }

    const screenshot = await page.screenshot({
      path: path.join(outputDir, `${definition.name}-final.png`),
      fullPage: false
    });
    if (screenshot.length < 25_000) {
      failures.push(`${definition.name} produced an unexpectedly empty final screenshot.`);
    }

    report.sweeps.push({
      name: definition.name,
      center: [...definition.center],
      direction: definition.direction,
      requiredLayers: [...definition.requiredLayers],
      checkpointCount: checkpoints.length,
      checkpoints,
      sourceChanged: checkpoints.some((checkpoint) => checkpoint.sourceChanged),
      blankCheckpointCount: checkpoints.filter((checkpoint) => checkpoint.renderedFeatureCount === 0).length,
      missingFoundationCheckpointCount: checkpoints.filter((checkpoint) =>
        definition.requiredLayers.some((layer) => (checkpoint.requiredLayerCounts?.[layer] || 0) <= 0)
      ).length,
      screenshotBytes: screenshot.length,
      failures,
      executionError: null
    });
    await persistReport();
  }

  const failedSweeps = report.sweeps.filter((sweep) => sweep.failures.length > 0);
  report.externalVectorRequests = [...new Set(report.externalVectorRequests)];
  report.passed =
    failedSweeps.length === 0 &&
    report.pageErrors.length === 0 &&
    report.networkFailures.length === 0 &&
    report.abortedTileRequests.length === 0 &&
    report.externalVectorRequests.length === 0;
  await persistReport();

  if (!report.passed) {
    throw new Error(`Deterministic all-zoom validation failed: ${safeStringify({
      failedSweeps,
      pageErrors: report.pageErrors,
      networkFailures: report.networkFailures,
      abortedTileRequests: report.abortedTileRequests,
      externalVectorRequests: report.externalVectorRequests
    })}`);
  }

  console.log(
    `Validated ${definitions.length * requestedZooms.length} deterministic zoom checkpoints with no blank or missing-foundation frames.`
  );
} catch (error) {
  report.fatalError = serializeError(error);
  report.passed = false;
  await persistReport().catch(() => {});
  throw error;
} finally {
  await browser?.close();
}
