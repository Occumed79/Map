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
    startZoom: definition.startZoom,
    endZoom: definition.endZoom,
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
    report.networkFailures.push({
      type: 'requestfailed',
      url: request.url(),
      error: request.failure()?.errorText || 'unknown request failure'
    });
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

  async function runSweep(definition) {
    const { name, center, startZoom, endZoom, requiredLayers } = definition;
    await page.evaluate(({ center, startZoom }) => {
      const map = globalThis.__OCCUMED_MAP__;
      map.jumpTo({ center, zoom: startZoom, pitch: 0, bearing: 0 });
      map.triggerRepaint();
    }, { center, startZoom });

    await page.waitForFunction(
      ({ requiredLayers }) => {
        const map = globalThis.__OCCUMED_MAP__;
        if (!map?.isStyleLoaded() || !map.areTilesLoaded()) return false;
        const rendered = map
          .queryRenderedFeatures()
          .filter((feature) => feature.source === 'occumed-open');
        if (!rendered.length) return false;
        return requiredLayers.every((required) =>
          rendered.some((feature) => feature.sourceLayer === required)
        );
      },
      { requiredLayers },
      { timeout: 90_000 }
    );

    const raw = await page.evaluate(async ({
      name,
      center,
      startZoom,
      endZoom,
      expectedTemplate,
      requiredLayers
    }) => {
      const map = globalThis.__OCCUMED_MAP__;
      const samples = [];
      let lastSampleAt = -Infinity;
      let sourceChanged = false;
      const expectedSignature = JSON.stringify({ url: null, tiles: [expectedTemplate] });

      const sample = (timestamp) => {
        if (timestamp - lastSampleAt < 55) return;
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
          timestamp: Number(timestamp),
          zoom: Number(map.getZoom()),
          renderedFeatureCount: rendered.length,
          requiredLayerCounts: Object.fromEntries(
            requiredLayers.map((layer) => [layer, sourceLayers[layer] || 0])
          ),
          sourceLayers,
          tilesLoaded: Boolean(map.areTilesLoaded()),
          sourceSignature: signature
        });
      };

      return await new Promise((resolve, reject) => {
        const durationMs = 20_000;
        const timeout = setTimeout(() => {
          map.off('render', sample);
          reject(new Error(`${name} full-range zoom sweep timed out.`));
        }, durationMs + 35_000);

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
          const missingFoundationSamples = samples.filter((entry) =>
            requiredLayers.some((layer) => (entry.requiredLayerCounts[layer] || 0) <= 0)
          );
          resolve({
            name,
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
    }, { name, center, startZoom, endZoom, expectedTemplate, requiredLayers });

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
        startZoom: definition.startZoom,
        endZoom: definition.endZoom,
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

  const failedSweeps = report.sweeps.filter((sweep) =>
    sweep.executionError ||
    sweep.sourceChanged ||
    sweep.blankSampleCount > 0 ||
    sweep.missingFoundationSampleCount > 0 ||
    sweep.sampleCount < 180 ||
    sweep.minimumZoom === null || sweep.minimumZoom > 0.1 ||
    sweep.maximumZoom === null || sweep.maximumZoom < 15.9 ||
    sweep.maximumZoomGap > 0.3
  );

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
      externalVectorRequests: report.externalVectorRequests
    })}`);
  }

  console.log(
    `Validated ${definitions.length} complete zoom 0–16 sweeps with ${report.sweeps.reduce((sum, sweep) => sum + sweep.sampleCount, 0)} sampled frames and no missing physical foundation layers.`
  );
} catch (error) {
  report.fatalError = serializeError(error);
  report.passed = false;
  await persistReport().catch(() => {});
  throw error;
} finally {
  await browser?.close();
}
