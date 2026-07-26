import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.OCCUMED_PREVIEW_ORIGIN || 'http://127.0.0.1:4173';
const outputDir = path.resolve(process.env.OCCUMED_PREVIEW_OUTPUT || 'artifacts/visual-preview');
const expectedArchive = process.env.OCCUMED_PREVIEW_ARCHIVE || 'occumed-fresno.pmtiles';
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
const networkFailures = [];

page.on('console', (message) => {
  consoleMessages.push({ type: message.type(), text: message.text() });
});
page.on('pageerror', (error) => {
  pageErrors.push(error.message);
});
page.on('requestfailed', (request) => {
  networkFailures.push({
    type: 'requestfailed',
    url: request.url(),
    method: request.method(),
    error: request.failure()?.errorText || 'unknown request failure'
  });
});
page.on('response', (response) => {
  if (response.status() < 400) return;
  networkFailures.push({
    type: 'http',
    url: response.url(),
    method: response.request().method(),
    status: response.status()
  });
});

await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(
  () => globalThis.__OCCUMED_MAP__ && globalThis.__OCCUMED_MAP__.isStyleLoaded(),
  null,
  { timeout: 60_000 }
);

function sourceUrl(source) {
  return typeof source?.url === 'string' ? source.url : '';
}

function assertHealthyView(name, view) {
  const url = sourceUrl(view.source);
  if (!url.startsWith('pmtiles://')) {
    throw new Error(`${name} did not use the PMTiles protocol: ${url || 'missing source URL'}`);
  }
  if (!url.includes(expectedArchive)) {
    throw new Error(`${name} used the wrong PMTiles archive: ${url}`);
  }
  if (!view.loaded) throw new Error(`${name} did not reach map.loaded().`);
  if (!view.tilesLoaded) throw new Error(`${name} did not reach map.areTilesLoaded().`);
  if (view.canvas.effectivePixelRatio < 1.9) {
    throw new Error(`${name} rendered below the required effective 2x pixel ratio.`);
  }
}

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
        setTimeout(finish, 20_000);
      });
    },
    { center, zoom }
  );

  await page.waitForFunction(
    () => {
      const map = globalThis.__OCCUMED_MAP__;
      return Boolean(map?.loaded() && map.areTilesLoaded());
    },
    null,
    { timeout: 60_000 }
  );

  const view = await page.evaluate(() => {
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

  assertHealthyView(name, view);
  await page.screenshot({
    path: path.join(outputDir, `${name}.png`),
    fullPage: false
  });
  return view;
}

const views = {};
views.fresnoRegional = await capture('fresno-regional-z8', [-119.55, 36.75], 8);
views.fresnoCity = await capture('fresno-city-z11', [-119.7871, 36.7378], 11);
views.fresnoStreet = await capture('fresno-street-z14', [-119.7871, 36.7378], 14);
views.sierraTerrain = await capture('sierra-terrain-z10', [-118.85, 36.85], 10);

const consoleFailures = consoleMessages.filter(
  (entry) => entry.type === 'error' || /failed|error|404|416/i.test(entry.text)
);
const allowedFailure = (entry) => {
  const url = entry.url || entry.text || '';
  return /\/favicon\.ico(?:$|\?)/i.test(url);
};
const unexpectedNetworkFailures = networkFailures.filter((entry) => !allowedFailure(entry));
const unexpectedConsoleFailures = consoleFailures.filter((entry) => !allowedFailure(entry));

const report = {
  generatedAt: new Date().toISOString(),
  origin,
  browser: 'chromium',
  expectedArchive,
  viewport: { width: 1440, height: 1000, deviceScaleFactor: 2 },
  views,
  pageErrors,
  networkFailures,
  consoleFailures,
  unexpectedNetworkFailures,
  unexpectedConsoleFailures,
  consoleMessages
};

await fs.writeFile(
  path.join(outputDir, 'preview-report.json'),
  `${JSON.stringify(report, null, 2)}\n`
);

try {
  if (pageErrors.length) {
    throw new Error(`Browser page errors: ${pageErrors.join('; ')}`);
  }
  if (unexpectedNetworkFailures.length) {
    throw new Error(`Unexpected browser resource failures: ${JSON.stringify(unexpectedNetworkFailures)}`);
  }
  if (unexpectedConsoleFailures.length) {
    throw new Error(`Unexpected browser console failures: ${JSON.stringify(unexpectedConsoleFailures)}`);
  }
} finally {
  await browser.close();
}

console.log(`Captured ${Object.keys(views).length} healthy custom PMTiles browser views in ${outputDir}.`);
