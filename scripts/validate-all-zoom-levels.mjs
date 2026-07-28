import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(
  process.env.OCCUMED_PREVIEW_OUTPUT || 'visual-validation/all-zoom-levels'
);
await fs.mkdir(outputDir, { recursive: true });

const expectedTemplate = `${origin}/tiles/{z}/{x}/{y}.pbf`;
const reportPath = path.join(outputDir, 'all-zoom-levels-report.json');
const report = {
  generatedAt: new Date().toISOString(),
  origin,
  expectedTemplate,
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

function normalizeSweep(result, definition) {
  return {
    name: String(result?.name || definition.name),
    center: [...definition.center],
    requestedStartZoom: definition.startZoom,
    requestedEndZoom: definition.endZoom,
    actualStartZoom: Number(result?.actualStartZoom),
    actualEndZoom: Number(result?.actualEndZoom),
    requiredLayers: [...definition.requiredLayers],
    sampleCount: Number(result?.sampleCount || 0),
    sourceChanged: Boolean(result?.sourceChanged),
    blankSampleCount: Number(result?.blankSampleCount || 0),
    missingFoundationSampleCount: Number(result?.missingFoundationSampleCount || 0),
    firstMissingFoundationSamples: Array.isArray(result?.firstMissingFoundationSamples)
      ? result.firstMissingFoundationSamples
      : [],
    minimumZoom: result?.minimumZoom === null || result?.minimumZoom === undefined
      ? null
      : Number(result.minimumZoom),
    maximumZoom: result?.maximumZoom === null || result?.maximumZoom === undefined
      ? null
      : Number(result.maximumZoom),
    maximumZoomGap: Number(result?.maximumZoomGap || 0),
    minimumFeatureCount: Number(result?.minimumFeatureCount || 0),
    postMoveendSettleMs: Number(result?.postMoveendSettleMs || 0),
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

  async function positionAndWait(center, zoom, requiredLayers) {
    return await page.evaluate(async ({ center, zoom, requiredLayers }) => {
      const map = globalThis.__OCCUMED_MAP__;
      map.jumpTo({ center, zoom, pitch: 0, bearing: 0 });
      map.triggerRepaint();

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`The source did not become idle with ${requiredLayers.join(', ')} rendered.`));
        }, 90_000);
        const interval = setInterval(check, 100);

        function requiredLayerCounts() {
          const counts = Object.fromEntries(requiredLayers.map((layer) => [layer, 0]));
          const layerIds = (map.getStyle().layers || [])
            .filter((layer) =>
              layer.source === 'occumed-open' &&
              requiredLayers.includes(layer['source-layer'])
            )
            .map((layer) => layer.id);
          if (layerIds.length === 0) return counts;
          for (const feature of map.queryRenderedFeatures({ layers: layerIds })) {
            const sourceLayer = feature.sourceLayer;
            if (sourceLayer in counts) counts[sourceLayer] += 1;
          }
          return counts;
        }

        function check() {
          const counts = requiredLayerCounts();
          if (
            map.isStyleLoaded() &&
            map.isSourceLoaded('occumed-open') &&
            requiredLayers.every((layer) => counts[layer] > 0)
          ) {
            cleanup();
            resolve();
          }
        }

        function onSourceData(event) {
          if (event.sourceId === 'occumed-open' && event.sourceDataType === 'idle') check();
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

      return Number(map.getZoom());
    }, { center, zoom, requiredLayers });
  }

  async function runSweep(definition) {
    const { name, center, startZoom, endZoom, requiredLayers } = definition;
    const actualStartZoom = await positionAndWait(center, startZoom, requiredLayers);

    const raw = await page.evaluate(async ({
      name,
      center,
      endZoom,
      expectedTemplate,
      requiredLayers,
      actualStartZoom
    }) => {
      const map = globalThis.__OCCUMED_MAP__;
      const samples = [];
      let sourceChanged = false;
      const expectedSignature = JSON.stringify({ url: null, tiles: [expectedTemplate] });

      const requiredLayerCounts = () => {
        const counts = Object.fromEntries(requiredLayers.map((layer) => [layer, 0]));
        const layerIds = (map.getStyle().layers || [])
          .filter((layer) =>
            layer.source === 'occumed-open' &&
            requiredLayers.includes(layer['source-layer'])
          )
          .map((layer) => layer.id);
        if (layerIds.length === 0) return counts;
        for (const feature of map.queryRenderedFeatures({ layers: layerIds })) {
          const sourceLayer = feature.sourceLayer;
          if (sourceLayer in counts) counts[sourceLayer] += 1;
        }
        return counts;
      };

      const waitForRequiredFoundation = () => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(
            `The source did not settle with ${requiredLayers.join(', ')} rendered after moveend.`
          ));
        }, 30_000);
        const interval = setInterval(check, 100);

        function check() {
          const counts = requiredLayerCounts();
          if (
            map.isStyleLoaded() &&
            map.isSourceLoaded('occumed-open') &&
            requiredLayers.every((layer) => counts[layer] > 0)
          ) {
            cleanup();
            resolve();
          }
        }

        function onSourceData(event) {
          if (event.sourceId === 'occumed-open') check();
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

      const sample = () => {
        const timestamp = performance.now();
        const source = map.getStyle().sources?.['occumed-open'] || null;
        const signature = JSON.stringify({ url: source?.url || null, tiles: source?.tiles || [] });
        sourceChanged ||= signature !== expectedSignature;
        const sourceLayers = requiredLayerCounts();
        const renderedFeatureCount = Object.values(sourceLayers)
          .reduce((total, count) => total + count, 0);
        samples.push({
          timestamp,
          zoom: Number(map.getZoom()),
          renderedFeatureCount,
          requiredLayerCounts: { ...sourceLayers },
          sourceLayers,
          tilesLoaded: Boolean(map.areTilesLoaded()),
          sourceSignature: signature
        });
      };

      return await new Promise((resolve, reject) => {
        const durationMs = 20_000;
        let sampleFrame = null;
        const queueSample = () => {
          if (sampleFrame !== null) return;
          sampleFrame = requestAnimationFrame(() => {
            sampleFrame = null;
            sample();
          });
        };
        const sampleTimer = setInterval(queueSample, 50);
        const stopSampling = () => {
          clearInterval(sampleTimer);
          if (sampleFrame !== null) {
            cancelAnimationFrame(sampleFrame);
            sampleFrame = null;
          }
        };
        const timeout = setTimeout(() => {
          stopSampling();
          map.off('moveend', finish);
          reject(new Error(`${name} full-range zoom sweep timed out.`));
        }, durationMs + 35_000);

        const finish = async () => {
          stopSampling();
          const moveendAt = performance.now();
          try {
            await waitForRequiredFoundation();
            clearTimeout(timeout);
            sample();
            const actualEndZoom = Number(map.getZoom());
            const zooms = samples.map((entry) => entry.zoom).sort((a, b) => a - b);
            let maximumZoomGap = 0;
            for (let index = 1; index < zooms.length; index += 1) {
              maximumZoomGap = Math.max(maximumZoomGap, zooms[index] - zooms[index - 1]);
            }
            const blankSamples = samples.filter((entry) => entry.renderedFeatureCount === 0);
            const missingFoundationSamples = samples.filter((entry) =>
              requiredLayers.some((layer) => (entry.requiredLayerCounts[layer] || 0) <= 0)
            );
            resolve({
              name,
              actualStartZoom,
              actualEndZoom,
              sampleCount: samples.length,
              sourceChanged,
              blankSampleCount: blankSamples.length,
              missingFoundationSampleCount: missingFoundationSamples.length,
              firstMissingFoundationSamples: missingFoundationSamples.slice(0, 20),
              minimumZoom: zooms.length ? Math.min(...zooms) : null,
              maximumZoom: zooms.length ? Math.max(...zooms) : null,
              maximumZoomGap,
              minimumFeatureCount: samples.length
                ? Math.min(...samples.map((entry) => entry.renderedFeatureCount))
                : 0,
              postMoveendSettleMs: performance.now() - moveendAt,
              samples
            });
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        };

        sample();
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
    }, { name, center, endZoom, expectedTemplate, requiredLayers, actualStartZoom });

    const result = normalizeSweep(raw, definition);
    await page.screenshot({
      path: path.join(outputDir, `${name}-final.png`),
      fullPage: false
    });
    report.sweeps.push(result);
    await persistReport();
    return result;
  }

  const definitions = [
    { name: 'amazon-all-zooms-in', center: [-60, -8], startZoom: 0, endZoom: 16, requiredLayers: ['land', 'landcover'] },
    { name: 'amazon-all-zooms-out', center: [-60, -8], startZoom: 16, endZoom: 0, requiredLayers: ['land', 'landcover'] },
    { name: 'pacific-all-zooms-in', center: [-140, 0], startZoom: 0, endZoom: 16, requiredLayers: ['depth'] },
    { name: 'pacific-all-zooms-out', center: [-140, 0], startZoom: 16, endZoom: 0, requiredLayers: ['depth'] },
    { name: 'europe-all-zooms-in', center: [12, 50], startZoom: 0, endZoom: 16, requiredLayers: ['land', 'landcover'] },
    { name: 'antimeridian-all-zooms-out', center: [179, 0], startZoom: 16, endZoom: 0, requiredLayers: ['depth'] }
  ];

  for (const definition of definitions) {
    try {
      await runSweep(definition);
    } catch (error) {
      report.sweeps.push({
        name: definition.name,
        center: [...definition.center],
        requestedStartZoom: definition.startZoom,
        requestedEndZoom: definition.endZoom,
        actualStartZoom: null,
        actualEndZoom: null,
        requiredLayers: [...definition.requiredLayers],
        sampleCount: 0,
        sourceChanged: false,
        blankSampleCount: 0,
        missingFoundationSampleCount: 0,
        firstMissingFoundationSamples: [],
        minimumZoom: null,
        maximumZoom: null,
        maximumZoomGap: 0,
        minimumFeatureCount: 0,
        postMoveendSettleMs: 0,
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

  const failedSweeps = report.sweeps.filter((sweep) => {
    if (sweep.executionError || sweep.sourceChanged) return true;
    if (sweep.blankSampleCount > 0 || sweep.missingFoundationSampleCount > 0) return true;
    if (sweep.sampleCount < 180 || sweep.maximumZoomGap > 0.3) return true;
    if (sweep.minimumZoom === null || sweep.maximumZoom === null) return true;
    const expectedMinimum = Math.min(sweep.actualStartZoom, sweep.actualEndZoom);
    const expectedMaximum = Math.max(sweep.actualStartZoom, sweep.actualEndZoom);
    return sweep.minimumZoom > expectedMinimum + 0.1 || sweep.maximumZoom < expectedMaximum - 0.1;
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
    `Validated ${definitions.length} complete effective-minimum-to-zoom-16 sweeps with 50ms sampling, ${report.sweeps.reduce((sum, sweep) => sum + sweep.sampleCount, 0)} sampled frames, and no missing physical foundation layers.`
  );
} catch (error) {
  report.fatalError = serializeError(error);
  report.passed = false;
  await persistReport().catch(() => {});
  throw error;
} finally {
  await browser?.close();
}
