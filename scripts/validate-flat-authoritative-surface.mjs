#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.OCCUMED_BASE_URL || 'http://127.0.0.1:4173';
const outputDir = path.resolve(process.env.OCCUMED_PREVIEW_OUTPUT || 'flat-surface-validation');
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--no-sandbox']
});

const pageErrors = [];
const networkFailures = [];
const consoleErrors = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || 'unknown';
    if (!failure.includes('ERR_ABORTED')) networkFailures.push(`${request.url()} :: ${failure}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => {
    const map = globalThis.__OCCUMED_MAP__;
    return Boolean(map && map.loaded() && map.areTilesLoaded());
  }, { timeout: 120_000 });
  await page.waitForTimeout(2_000);

  const report = await page.evaluate(() => {
    const map = globalThis.__OCCUMED_MAP__;
    const style = map.getStyle();
    const landLayerIds = (style.layers || [])
      .filter((layer) => layer.source === 'occumed-open' && layer['source-layer'] === 'land' && layer.type === 'fill')
      .map((layer) => layer.id);
    const landFeatures = landLayerIds.length
      ? map.queryRenderedFeatures({ layers: landLayerIds })
      : [];
    return {
      projection: map.getProjection()?.type,
      zoom: map.getZoom(),
      center: map.getCenter().toArray(),
      sourceIds: Object.keys(style.sources || {}),
      sourceMaxZoom: style.sources?.['occumed-open']?.maxzoom,
      landLayerIds,
      renderedLandFeatures: landFeatures.length,
      canvas: {
        width: map.getCanvas().width,
        height: map.getCanvas().height
      },
      tilesLoaded: map.areTilesLoaded()
    };
  });

  await page.screenshot({
    path: path.join(outputDir, 'flat-authoritative-world.png'),
    fullPage: true
  });

  const result = { report, pageErrors, networkFailures, consoleErrors };
  await fs.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);

  const failures = [];
  if (report.projection !== 'mercator') failures.push(`Projection is ${report.projection}.`);
  if (JSON.stringify(report.sourceIds) !== JSON.stringify(['occumed-open'])) failures.push(`Unexpected sources: ${report.sourceIds.join(', ')}`);
  if (report.sourceMaxZoom !== 5) failures.push(`Source maxzoom is ${report.sourceMaxZoom}.`);
  if (!report.landLayerIds.length) failures.push('No authoritative land fill layer is active.');
  if (report.renderedLandFeatures < 1) failures.push('No land polygons rendered in the viewport.');
  if (!report.tilesLoaded) failures.push('Tiles did not finish loading.');
  if (pageErrors.length) failures.push(`Page errors: ${pageErrors.join(' | ')}`);
  if (networkFailures.length) failures.push(`Network failures: ${networkFailures.join(' | ')}`);

  if (failures.length) {
    throw new Error(`Flat authoritative-surface validation failed:\n- ${failures.join('\n- ')}`);
  }

  console.log(`Flat authoritative surface rendered ${report.renderedLandFeatures} land features with one Mercator source.`);
} finally {
  await browser.close();
}
