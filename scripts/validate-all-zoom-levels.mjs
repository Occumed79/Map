import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(
  process.env.OCCUMED_PREVIEW_OUTPUT || 'visual-validation/all-zoom-levels'
);
const zoomStep = Number(process.env.OCCUMED_ALL_ZOOM_STEP || 0.5);

if (!Number.isFinite(zoomStep) || zoomStep <= 0 || zoomStep > 1) {
  throw new Error('OCCUMED_ALL_ZOOM_STEP must be greater than 0 and no more than 1.');
}

await fs.mkdir(outputDir, { recursive: true });

const expectedTemplate = `${origin}/tiles/{z}/{x}/{y}.pbf`;
const reportPath = path.join(outputDir, 'all-zoom-levels-report.json');
const report = {
  generatedAt: new Date().toISOString(),
  origin,
  expectedTemplate,
  zoomStep,
  sourceContract: null,
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

function checkpointZooms(startZoom, endZoom) {
  const direction = endZoom >= startZoom ? 1 : -1;
  const values = [startZoom];
  let current = startZoom;
  while ((direction > 0 && current + zoomStep < endZoom) || (direction < 0 && current - zoomStep > endZoom)) {
    current = Number((current + direction * zoomStep).toFixed(6));
    values.push(current);
  }
  if (values.at(-1) !== endZoom) values.push(endZoom);
  return values;
}

const definitions = [
  { name: 'amazon-all-zooms-in', center: [-60, -8], startZoom: 0, endZoom: 16, requiredLayers: ['land', 'landcover'] },
  { name: 'amazon-all-zooms-out', center: [-60, -8], startZoom: 16, endZoom: 0, requiredLayers: ['land', 'landcover'] },
  { name: 'pacific-all-zooms-in', center: [-140, 0], startZoom: 0, endZoom: 16, requiredLayers: ['depth'] },
  { name: 'pacific-all-zooms-out', center: [-140, 0], startZoom: 16, endZoom: 0, requiredLayers: ['depth'] },
  { name: 'europe-all-zooms-in', center: [12, 50], startZoom: 0, endZoom: 16, requiredLayers: ['land', 'landcover'] },
  { name: 'antimeridian-all-zooms-out', center: [179, 0], startZoom: 16, endZoom: 0, requiredLayers: ['depth'] }
];

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
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

  report.sourceContract = await page.evaluate(({ expectedTemplate }) => {
    const map = globalThis.__OCCUMED_MAP__;
    map.setPixelRatio(1);
    const sources = map.getStyle().sources || {};
    const sourceIds = Object.keys(sources);
    const source = sources['occumed-open'] || null;
    return {
      sourceIds,
      sourceCount: sourceIds.length,
      type: source?.type || null,
      tiles: Array.isArray(source?.tiles) ? [...source.tiles] : [],
      minzoom: source?.minzoom ?? null,
      maxzoom: source?.maxzoom ?? null,
      expectedTemplate,
      valid:
        sourceIds.length === 1 &&
        sourceIds[0] === 'occumed-open' &&
        source?.type === 'vector' &&
        Array.isArray(source?.tiles) &&
        source.tiles.length === 1 &&
        source.tiles[0] === expectedTemplate &&
        Number(source?.maxzoom) === 5
    };
  }, { expectedTemplate });

  if (!report.sourceContract.valid) {
    throw new Error(`Emergency source contract is invalid: ${safeStringify(report.sourceContract)}`);
  }

  async function validateCheckpoint(definition, targetZoom) {
    return page.evaluate(async ({ definition, targetZoom, expectedTemplate }) => {
      const map = globalThis.__OCCUMED_MAP__;
      const requiredLayers = definition.requiredLayers;
      const expectedSignature = JSON.stringify({ url: null, tiles: [expectedTemplate] });

      function requiredLayerCounts() {
        const counts = Object.fromEntries(requiredLayers.map((layer) => [layer, 0]));
        const layerIds = Object.fromEntries(requiredLayers.map((sourceLayer) => [
          sourceLayer,
          (map.getStyle().layers || [])
            .filter((layer) =>
              layer.source === 'occumed-open' &&
              layer['source-layer'] === sourceLayer
            )
            .map((layer) => layer.id)
        ]));
        const tileManager = map.style?.tileManagers?.['occumed-open'];
        if (!tileManager) return counts;
        for (const id of tileManager.getRenderableIds()) {
          const tile = tileManager.getTileByID(id);
          for (const sourceLayer of requiredLayers) {
            if (layerIds[sourceLayer].some((layerId) => tile?.buckets?.[layerId])) {
              counts[sourceLayer] += 1;
            }
          }
        }
        return counts;
      }

      map.jumpTo({ center: definition.center, zoom: targetZoom, pitch: 0, bearing: 0 });
      map.triggerRepaint();

      const startedAt = performance.now();
      const state = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(
            `${definition.name} did not render ${requiredLayers.join(', ')} at zoom ${targetZoom}.`
          ));
        }, 30_000);
        const interval = setInterval(check, 50);

        function check() {
          const source = map.getStyle().sources?.['occumed-open'] || null;
          const signature = JSON.stringify({ url: source?.url || null, tiles: source?.tiles || [] });
          const counts = requiredLayerCounts();
          const actualZoom = Number(map.getZoom());
          const cameraReached = Math.abs(actualZoom - targetZoom) <= 0.05;
          const foundationRendered = requiredLayers.every((layer) => counts[layer] > 0);
          if (map.isStyleLoaded() && cameraReached && foundationRendered) {
            cleanup();
            resolve({
              targetZoom,
              actualZoom,
              renderedFeatureCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
              requiredLayerCounts: counts,
              sourceSignature: signature,
              sourceChanged: signature !== expectedSignature,
              tilesLoaded: Boolean(map.areTilesLoaded()),
              settleMs: performance.now() - startedAt
            });
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          clearInterval(interval);
          map.off('render', check);
          map.off('sourcedata', check);
        }

        map.on('render', check);
        map.on('sourcedata', check);
        check();
      });

      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return state;
    }, { definition, targetZoom, expectedTemplate });
  }

  for (const definition of definitions) {
    const sweep = {
      name: definition.name,
      center: [...definition.center],
      requestedStartZoom: definition.startZoom,
      requestedEndZoom: definition.endZoom,
      requiredLayers: [...definition.requiredLayers],
      checkpoints: [],
      sampleCount: 0,
      sourceChanged: false,
      blankSampleCount: 0,
      missingFoundationSampleCount: 0,
      minimumZoom: null,
      maximumZoom: null,
      maximumZoomGap: 0,
      executionError: null
    };

    try {
      const targets = checkpointZooms(definition.startZoom, definition.endZoom);
      for (const targetZoom of targets) {
        const checkpoint = await validateCheckpoint(definition, targetZoom);
        sweep.checkpoints.push(checkpoint);
      }

      const zooms = sweep.checkpoints.map((entry) => entry.actualZoom).sort((a, b) => a - b);
      sweep.sampleCount = sweep.checkpoints.length;
      sweep.sourceChanged = sweep.checkpoints.some((entry) => entry.sourceChanged);
      sweep.blankSampleCount = sweep.checkpoints.filter((entry) => entry.renderedFeatureCount <= 0).length;
      sweep.missingFoundationSampleCount = sweep.checkpoints.filter((entry) =>
        definition.requiredLayers.some((layer) => (entry.requiredLayerCounts[layer] || 0) <= 0)
      ).length;
      sweep.minimumZoom = zooms.length ? Math.min(...zooms) : null;
      sweep.maximumZoom = zooms.length ? Math.max(...zooms) : null;
      for (let index = 1; index < zooms.length; index += 1) {
        sweep.maximumZoomGap = Math.max(sweep.maximumZoomGap, zooms[index] - zooms[index - 1]);
      }

      await page.screenshot({
        path: path.join(outputDir, `${definition.name}-final.png`),
        fullPage: false
      });
    } catch (error) {
      sweep.executionError = serializeError(error);
      await page.screenshot({
        path: path.join(outputDir, `${definition.name}-error.png`),
        fullPage: false
      }).catch(() => {});
    }

    report.sweeps.push(sweep);
    await persistReport();
  }

  const failedSweeps = report.sweeps.filter((sweep) => {
    if (sweep.executionError || sweep.sourceChanged) return true;
    if (sweep.blankSampleCount > 0 || sweep.missingFoundationSampleCount > 0) return true;
    const expectedSamples = checkpointZooms(sweep.requestedStartZoom, sweep.requestedEndZoom).length;
    if (sweep.sampleCount !== expectedSamples || sweep.maximumZoomGap > zoomStep + 0.06) return true;
    if (sweep.minimumZoom === null || sweep.maximumZoom === null) return true;
    const expectedMinimum = Math.min(sweep.requestedStartZoom, sweep.requestedEndZoom);
    const expectedMaximum = Math.max(sweep.requestedStartZoom, sweep.requestedEndZoom);
    return sweep.minimumZoom > expectedMinimum + 0.06 || sweep.maximumZoom < expectedMaximum - 0.06;
  });

  report.externalVectorRequests = [...new Set(report.externalVectorRequests)];
  report.passed =
    failedSweeps.length === 0 &&
    report.pageErrors.length === 0 &&
    report.networkFailures.length === 0 &&
    report.externalVectorRequests.length === 0;
  await persistReport();

  if (!report.passed) {
    throw new Error(`All-zoom validation failed: ${safeStringify({
      failedSweeps,
      pageErrors: report.pageErrors,
      networkFailures: report.networkFailures,
      abortedTileRequestCount: report.abortedTileRequests.length,
      externalVectorRequests: report.externalVectorRequests
    })}`);
  }

  console.log(
    `Validated ${definitions.length} deterministic zoom sweeps at ${zoomStep}-zoom checkpoints with one immutable source and no missing foundation layers.`
  );
} catch (error) {
  report.fatalError = serializeError(error);
  report.passed = false;
  await persistReport().catch(() => {});
  throw error;
} finally {
  await browser?.close();
}
