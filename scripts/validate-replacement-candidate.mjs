#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = (process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173').replace(/\/$/, '');
const outputDir = path.resolve(process.env.OCCUMED_PREVIEW_OUTPUT || 'candidate-validation');
const family = process.env.OCCUMED_CANDIDATE_FAMILY?.trim() || 'sul';
const expectedTemplate = `${origin}/tiles/{z}/{x}/{y}.pbf`;

const defaultConfig = {
  views: [
    { name: 'sul-regional', center: [-51.9, -28.69], zoom: 6, requiredLayers: ['land', 'landcover'] },
    { name: 'porto-alegre', center: [-51.23, -30.03], zoom: 14, requiredLayers: ['land', 'transportation', 'building'] },
    { name: 'curitiba', center: [-49.27, -25.43], zoom: 14, requiredLayers: ['land', 'transportation', 'building'] },
    { name: 'florianopolis', center: [-48.55, -27.59], zoom: 12, requiredLayers: ['land', 'transportation'] },
    { name: 'former-split-cross-west', center: [-52.05, -28.69], zoom: 9, requiredLayers: ['land', 'landcover', 'transportation'] },
    { name: 'former-split-cross-east', center: [-51.75, -28.69], zoom: 9, requiredLayers: ['land', 'landcover', 'transportation'] },
    { name: 'former-split-cross-north', center: [-51.9, -28.54], zoom: 9, requiredLayers: ['land', 'landcover', 'transportation'] },
    { name: 'former-split-cross-south', center: [-51.9, -28.84], zoom: 9, requiredLayers: ['land', 'landcover', 'transportation'] }
  ],
  sweeps: [
    { name: 'porto-alegre-zoom-in', center: [-51.23, -30.03], startZoom: 0, endZoom: 16, requiredLayers: ['land'] },
    { name: 'porto-alegre-zoom-out', center: [-51.23, -30.03], startZoom: 16, endZoom: 0, requiredLayers: ['land'] },
    { name: 'split-cross-zoom-in', center: [-51.9, -28.69], startZoom: 0, endZoom: 16, requiredLayers: ['land'] }
  ]
};

const config = process.env.OCCUMED_CANDIDATE_VALIDATION_CONFIG
  ? JSON.parse(process.env.OCCUMED_CANDIDATE_VALIDATION_CONFIG)
  : defaultConfig;

await fs.mkdir(outputDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  family,
  origin,
  expectedTemplate,
  sourceContract: null,
  views: [],
  sweeps: [],
  pageErrors: [],
  networkFailures: [],
  externalVectorRequests: [],
  passed: false
};

function layerCountsInPage() {
  const map = globalThis.__OCCUMED_MAP__;
  const sourceLayerNames = [...new Set(
    (map.getStyle().layers || [])
      .filter((layer) => layer.source === 'occumed-open' && layer['source-layer'])
      .map((layer) => layer['source-layer'])
  )];
  const layerIds = Object.fromEntries(sourceLayerNames.map((sourceLayer) => [
    sourceLayer,
    (map.getStyle().layers || [])
      .filter((layer) => layer.source === 'occumed-open' && layer['source-layer'] === sourceLayer)
      .map((layer) => layer.id)
  ]));
  const counts = Object.fromEntries(sourceLayerNames.map((name) => [name, 0]));
  const manager = map.style?.tileManagers?.['occumed-open'];
  if (!manager) return counts;
  for (const id of manager.getRenderableIds()) {
    const tile = manager.getTileByID(id);
    for (const sourceLayer of sourceLayerNames) {
      if (layerIds[sourceLayer].some((layerId) => tile?.buckets?.[layerId])) counts[sourceLayer] += 1;
    }
  }
  return counts;
}

async function waitForPosition(page, definition) {
  return page.evaluate(async ({ definition, expectedTemplate }) => {
    const map = globalThis.__OCCUMED_MAP__;
    map.jumpTo({ center: definition.center, zoom: definition.zoom, pitch: 0, bearing: 0 });
    map.triggerRepaint();

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out at ${definition.name} z${definition.zoom}.`));
      }, 60_000);
      const interval = setInterval(check, 100);

      function counts() {
        const sourceLayerNames = [...new Set(
          (map.getStyle().layers || [])
            .filter((layer) => layer.source === 'occumed-open' && layer['source-layer'])
            .map((layer) => layer['source-layer'])
        )];
        const layerIds = Object.fromEntries(sourceLayerNames.map((sourceLayer) => [
          sourceLayer,
          (map.getStyle().layers || [])
            .filter((layer) => layer.source === 'occumed-open' && layer['source-layer'] === sourceLayer)
            .map((layer) => layer.id)
        ]));
        const values = Object.fromEntries(sourceLayerNames.map((name) => [name, 0]));
        const manager = map.style?.tileManagers?.['occumed-open'];
        if (!manager) return values;
        for (const id of manager.getRenderableIds()) {
          const tile = manager.getTileByID(id);
          for (const sourceLayer of sourceLayerNames) {
            if (layerIds[sourceLayer].some((layerId) => tile?.buckets?.[layerId])) values[sourceLayer] += 1;
          }
        }
        return values;
      }

      function check() {
        const layerCounts = counts();
        const source = map.getStyle().sources?.['occumed-open'];
        const signature = JSON.stringify({ url: source?.url || null, tiles: source?.tiles || [] });
        if (
          map.isStyleLoaded() &&
          map.isSourceLoaded('occumed-open') &&
          signature === JSON.stringify({ url: null, tiles: [expectedTemplate] }) &&
          definition.requiredLayers.every((layer) => (layerCounts[layer] || 0) > 0)
        ) {
          cleanup();
          resolve({
            actualCenter: [map.getCenter().lng, map.getCenter().lat],
            actualZoom: map.getZoom(),
            layerCounts,
            tilesLoaded: map.areTilesLoaded(),
            sourceSignature: signature
          });
        }
      }

      function cleanup() {
        clearTimeout(timeout);
        clearInterval(interval);
        map.off('idle', check);
        map.off('sourcedata', check);
      }
      map.on('idle', check);
      map.on('sourcedata', check);
      check();
    });
    return result;
  }, { definition, expectedTemplate });
}

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
    const error = request.failure()?.errorText || 'unknown request failure';
    if (error === 'net::ERR_ABORTED') return;
    report.networkFailures.push({ url: request.url(), error });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) report.networkFailures.push({ url: response.url(), status: response.status() });
  });

  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => globalThis.__OCCUMED_MAP__?.isStyleLoaded(), null, { timeout: 90_000 });

  report.sourceContract = await page.evaluate(({ expectedTemplate }) => {
    const map = globalThis.__OCCUMED_MAP__;
    const sources = map.getStyle().sources || {};
    const source = sources['occumed-open'];
    return {
      sourceIds: Object.keys(sources),
      type: source?.type || null,
      tiles: source?.tiles || [],
      minzoom: source?.minzoom,
      maxzoom: source?.maxzoom,
      expectedTemplate,
      initialLayerCounts: (() => {
        const counts = {};
        for (const layer of map.getStyle().layers || []) {
          if (layer.source !== 'occumed-open' || !layer['source-layer']) continue;
          counts[layer['source-layer']] = (counts[layer['source-layer']] || 0) + 1;
        }
        return counts;
      })()
    };
  }, { expectedTemplate });

  for (const view of config.views || []) {
    const result = await waitForPosition(page, view);
    const screenshot = path.join(outputDir, `${view.name}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    report.views.push({ ...view, ...result, screenshot: path.basename(screenshot) });
  }

  for (const sweep of config.sweeps || []) {
    const direction = sweep.endZoom >= sweep.startZoom ? 1 : -1;
    const checkpoints = [];
    for (let zoom = sweep.startZoom; direction > 0 ? zoom <= sweep.endZoom : zoom >= sweep.endZoom; zoom += direction) {
      const definition = {
        name: `${sweep.name}-z${zoom}`,
        center: sweep.center,
        zoom,
        requiredLayers: sweep.requiredLayers
      };
      checkpoints.push({ zoom, ...(await waitForPosition(page, definition)) });
    }
    report.sweeps.push({ ...sweep, checkpoints });
  }

  report.externalVectorRequests = [...new Set(report.externalVectorRequests)];
  report.passed =
    report.sourceContract.sourceIds.length === 1 &&
    report.sourceContract.sourceIds[0] === 'occumed-open' &&
    report.sourceContract.type === 'vector' &&
    JSON.stringify(report.sourceContract.tiles) === JSON.stringify([expectedTemplate]) &&
    Number(report.sourceContract.maxzoom) === 16 &&
    report.views.every((view) => view.requiredLayers.every((layer) => (view.layerCounts[layer] || 0) > 0)) &&
    report.sweeps.every((sweep) => sweep.checkpoints.length === Math.abs(sweep.endZoom - sweep.startZoom) + 1) &&
    report.pageErrors.length === 0 &&
    report.networkFailures.length === 0 &&
    report.externalVectorRequests.length === 0;

  await fs.writeFile(path.join(outputDir, 'candidate-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) throw new Error(`Candidate ${family} validation failed.`);
  console.log(`Candidate ${family} passed ${report.views.length} static views and ${report.sweeps.reduce((sum, sweep) => sum + sweep.checkpoints.length, 0)} deterministic zoom checkpoints.`);
} catch (error) {
  report.fatalError = { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || null };
  await fs.writeFile(path.join(outputDir, 'candidate-report.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  throw error;
} finally {
  await browser?.close();
}
