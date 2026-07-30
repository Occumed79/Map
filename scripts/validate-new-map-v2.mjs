#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.OCCUMED_PREVIEW_URL || 'http://127.0.0.1:4173';
const outputDir = path.resolve(process.env.OCCUMED_PREVIEW_OUTPUT || 'new-map-v2-validation');
await fs.mkdir(outputDir, { recursive: true });

const views = [
  {
    id: 'world',
    center: [0, 18],
    zoom: 1.25,
    requiredLandPoints: [
      [-118.24, 34.05],
      [-99.13, 19.43],
      [-46.63, -23.55],
      [-0.13, 51.51],
      [31.24, 30.04],
      [3.38, 6.52],
      [77.21, 28.61],
      [139.69, 35.68],
      [151.21, -33.87]
    ]
  },
  { id: 'north-america', center: [-100, 39], zoom: 3.35, requiredLandPoints: [[-118.24, 34.05], [-99.13, 19.43], [-74.01, 40.71]] },
  { id: 'europe-africa', center: [15, 28], zoom: 3.1, requiredLandPoints: [[-0.13, 51.51], [31.24, 30.04], [3.38, 6.52]] },
  { id: 'fresno', center: [-119.7871, 36.7378], zoom: 11, requiredLandPoints: [[-119.7871, 36.7378]] }
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];
const badResponses = [];

page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText || 'request failed';
  if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) failedRequests.push(`${failure} ${request.url()}`);
});
page.on('response', (response) => {
  if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
});

const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
if (!response?.ok()) throw new Error(`Map page returned HTTP ${response?.status() || 'unknown'}.`);

await page.waitForFunction(
  () => globalThis.__OCCUMED_MAP_V2__?.ready === true,
  undefined,
  { timeout: 60_000 }
);

async function settleView(center, zoom) {
  await page.evaluate(({ center, zoom }) => new Promise((resolve, reject) => {
    const map = globalThis.__OCCUMED_MAP__;
    if (!map) {
      reject(new Error('Map instance missing.'));
      return;
    }
    const timeout = setTimeout(() => reject(new Error('View did not become idle.')), 45_000);
    const finish = () => {
      if (!map.loaded() || !map.areTilesLoaded()) return;
      clearTimeout(timeout);
      map.off('idle', finish);
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    };
    map.on('idle', finish);
    map.jumpTo({ center, zoom, bearing: 0, pitch: 0 });
    finish();
  }), { center, zoom });
}

const results = [];
for (const view of views) {
  await settleView(view.center, view.zoom);
  const inspection = await page.evaluate(({ requiredLandPoints }) => {
    const map = globalThis.__OCCUMED_MAP__;
    const style = map.getStyle();
    const canvas = map.getCanvas();
    const viewportFeatures = map.queryRenderedFeatures();
    const pointChecks = requiredLandPoints.map((coordinate) => {
      const point = map.project(coordinate);
      const visible = point.x >= 0 && point.y >= 0 && point.x <= canvas.clientWidth && point.y <= canvas.clientHeight;
      const features = visible ? map.queryRenderedFeatures(point) : [];
      const sourceLayers = [...new Set(features.map((feature) => feature.sourceLayer).filter(Boolean))].sort();
      const layerIds = [...new Set(features.map((feature) => feature.layer?.id).filter(Boolean))].sort();
      const keys = [...sourceLayers, ...layerIds].map((value) => String(value).toLowerCase());
      return {
        coordinate,
        visible,
        featureCount: features.length,
        sourceLayers,
        layerIds,
        resolvesToWater: keys.some((key) => /water|ocean|lake|river|marine|bay/.test(key))
      };
    });

    return {
      center: map.getCenter().toArray(),
      zoom: map.getZoom(),
      projection: style.projection?.type || map.getProjection?.()?.type || null,
      sourceCount: Object.keys(style.sources || {}).length,
      vectorSourceCount: Object.values(style.sources || {}).filter((source) => source?.type === 'vector').length,
      sourceLoaded: Object.keys(style.sources || {}).every((sourceId) => map.isSourceLoaded(sourceId)),
      tilesLoaded: map.areTilesLoaded(),
      renderedFeatureCount: viewportFeatures.length,
      renderedSourceLayers: [...new Set(viewportFeatures.map((feature) => feature.sourceLayer).filter(Boolean))].sort(),
      renderedLayerIds: [...new Set(viewportFeatures.map((feature) => feature.layer?.id).filter(Boolean))].sort(),
      forbiddenLayerCount: (style.layers || []).filter((layer) => ['sky', 'hillshade', 'model', 'fill-extrusion'].includes(layer.type)).length,
      terrain: style.terrain || null,
      fog: style.fog || null,
      architecture: style.metadata?.['occumed:architecture'] || null,
      pointChecks
    };
  }, { requiredLandPoints: view.requiredLandPoints });

  await page.screenshot({
    path: path.join(outputDir, `${view.id}.png`),
    fullPage: true
  });

  const invisibleRequiredPoints = inspection.pointChecks.filter((point) => !point.visible);
  const waterRequiredPoints = inspection.pointChecks.filter((point) => point.visible && point.resolvesToWater);
  const minimumFeatureCount = view.id === 'fresno' ? 80 : 25;
  const minimumSourceLayerCount = view.id === 'fresno' ? 4 : 3;

  if (inspection.projection !== 'mercator') throw new Error(`${view.id}: projection is ${inspection.projection}.`);
  if (inspection.sourceCount !== 1 || inspection.vectorSourceCount !== 1) {
    throw new Error(`${view.id}: expected one vector source, found ${inspection.sourceCount} total and ${inspection.vectorSourceCount} vector.`);
  }
  if (!inspection.sourceLoaded || !inspection.tilesLoaded) throw new Error(`${view.id}: worldwide source or tiles did not fully load.`);
  if (inspection.renderedFeatureCount < minimumFeatureCount) {
    throw new Error(`${view.id}: only ${inspection.renderedFeatureCount} features rendered.`);
  }
  if (inspection.renderedSourceLayers.length < minimumSourceLayerCount) {
    throw new Error(`${view.id}: only ${inspection.renderedSourceLayers.length} source layers rendered.`);
  }
  if (inspection.forbiddenLayerCount || inspection.terrain || inspection.fog) {
    throw new Error(`${view.id}: globe, terrain, or forbidden 3D layers remain active.`);
  }
  if (inspection.architecture !== 'clean-worldwide-vector-v2') {
    throw new Error(`${view.id}: architecture metadata is ${inspection.architecture}.`);
  }
  if (invisibleRequiredPoints.length) {
    throw new Error(`${view.id}: required land points fell outside the viewport: ${JSON.stringify(invisibleRequiredPoints)}.`);
  }
  if (waterRequiredPoints.length) {
    throw new Error(`${view.id}: required land points resolved to water layers: ${JSON.stringify(waterRequiredPoints)}.`);
  }

  results.push({ id: view.id, ...inspection });
}

const contract = await page.evaluate(() => globalThis.__OCCUMED_MAP_V2__);
const report = {
  baseUrl,
  contract,
  views: results,
  pageErrors,
  consoleErrors,
  failedRequests,
  badResponses
};
await fs.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

await browser.close();

if (pageErrors.length || consoleErrors.length || failedRequests.length || badResponses.length) {
  throw new Error(`Browser/network errors detected: ${JSON.stringify({ pageErrors, consoleErrors, failedRequests, badResponses })}`);
}

console.log(JSON.stringify({
  validated: true,
  architecture: contract.architecture,
  sourceCount: contract.sourceCount,
  screenshots: views.map((view) => `${view.id}.png`),
  viewFeatureCounts: Object.fromEntries(results.map((view) => [view.id, view.renderedFeatureCount]))
}, null, 2));
