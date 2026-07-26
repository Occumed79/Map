import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173';
const outputDir = path.resolve(process.env.OCCUMED_PREVIEW_OUTPUT || 'artifacts/visual-preview');
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: 'dark'
});
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];

page.on('console', (message) => {
  consoleMessages.push({ type: message.type(), text: message.text() });
});
page.on('pageerror', (error) => {
  pageErrors.push(error.message);
});

await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(
  () => globalThis.__OCCUMED_MAP__ && globalThis.__OCCUMED_MAP__.isStyleLoaded(),
  null,
  { timeout: 60_000 }
);

async function capture(name, center, zoom) {
  await page.evaluate(
    async ({ center: nextCenter, zoom: nextZoom }) => {
      const map = globalThis.__OCCUMED_MAP__;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        map.once('idle', finish);
        map.jumpTo({ center: nextCenter, zoom: nextZoom, pitch: 0, bearing: 0 });
        setTimeout(finish, 12_000);
      });
    },
    { center, zoom }
  );

  await page.waitForTimeout(750);
  await page.screenshot({
    path: path.join(outputDir, `${name}.png`),
    fullPage: false
  });

  return page.evaluate(() => {
    const map = globalThis.__OCCUMED_MAP__;
    const canvas = map.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const source = map.getStyle().sources?.['occumed-open'] || null;
    return {
      center: map.getCenter().toArray(),
      zoom: map.getZoom(),
      source,
      canvas: {
        cssWidth: rect.width,
        cssHeight: rect.height,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        effectivePixelRatio: rect.width ? canvas.width / rect.width : null
      },
      loaded: map.loaded(),
      tilesLoaded: map.areTilesLoaded(),
      visibleLayers: map
        .getStyle()
        .layers.filter((layer) => map.getLayoutProperty(layer.id, 'visibility') !== 'none')
        .map((layer) => layer.id)
    };
  });
}

const views = {};
views.fresnoRegional = await capture('fresno-regional-z8', [-119.55, 36.75], 8);
views.fresnoCity = await capture('fresno-city-z11', [-119.7871, 36.7378], 11);
views.fresnoStreet = await capture('fresno-street-z14', [-119.7871, 36.7378], 14);
views.sierraTerrain = await capture('sierra-terrain-z10', [-118.85, 36.85], 10);

const resourceFailures = consoleMessages.filter(
  (entry) => entry.type === 'error' || /failed|error|404|416/i.test(entry.text)
);

const report = {
  generatedAt: new Date().toISOString(),
  origin,
  browser: 'chromium',
  viewport: { width: 1440, height: 1000, deviceScaleFactor: 2 },
  views,
  pageErrors,
  resourceFailures,
  consoleMessages
};

await fs.writeFile(
  path.join(outputDir, 'preview-report.json'),
  `${JSON.stringify(report, null, 2)}\n`
);

if (pageErrors.length) {
  throw new Error(`Browser page errors: ${pageErrors.join('; ')}`);
}
if (resourceFailures.some((entry) => /pmtiles|occumed-open/i.test(entry.text))) {
  throw new Error(
    `Custom PMTiles source failures: ${resourceFailures.map((entry) => entry.text).join('; ')}`
  );
}
if (Object.values(views).some((view) => view.canvas.effectivePixelRatio < 1.9)) {
  throw new Error('A captured map view rendered below the required effective 2x pixel ratio.');
}

await browser.close();
console.log(`Captured ${Object.keys(views).length} custom PMTiles browser views in ${outputDir}.`);
