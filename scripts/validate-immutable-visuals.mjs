#!/usr/bin/env node

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const VIEWPORT = { width: 1440, height: 1000 };
const MOTION_DURATION_MS = 12_600;

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
    result[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ['manifest', 'targets', 'output-dir']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  return result;
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

async function waitForReadiness(origin, expectedStatus, timeoutMs = 30_000) {
  const started = Date.now();
  let lastStatus = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${origin}/readyz`, { cache: 'no-store' });
      lastStatus = response.status;
      if (response.status === expectedStatus) {
        return {
          status: response.status,
          body: await response.json().catch(() => null)
        };
      }
    } catch {
      // The child may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Readiness did not return ${expectedStatus}; last status was ${lastStatus}.`);
}

async function startServer({
  manifest,
  port,
  allowPartial,
  logPath
}) {
  const handle = await fs.open(logPath, 'wx');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      OCCUMED_IMMUTABLE_TILESET_MANIFEST: manifest,
      OCCUMED_ALLOW_PARTIAL_TILESET_FIXTURE: allowPartial ? 'true' : 'false'
    },
    stdio: ['ignore', handle.fd, handle.fd]
  });
  child.once('exit', () => {
    void handle.close().catch(() => {});
  });
  return { child, handle, origin: `http://127.0.0.1:${port}` };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function waitForRequestSettlement(outstanding, timeoutMs = 20_000) {
  const started = Date.now();
  let idleSince = outstanding.size ? null : Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!outstanding.size) {
      idleSince ||= Date.now();
      if (Date.now() - idleSince >= 250) return;
    } else {
      idleSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Tile delivery did not settle; ${outstanding.size} requests remain.`);
}

async function waitForInViewTileSettlement(page, timeoutMs = 30_000) {
  const started = Date.now();
  let state = await mapState(page);
  while (Date.now() - started < timeoutMs) {
    const tiles = state.inViewTiles;
    if (tiles.length > 0 && tiles.every((tile) => tile.state !== 'loading')) {
      await pumpRenderFrames(page, 4, 2_000);
      return mapState(page);
    }
    await pumpRenderFrames(page, 1, 500);
    await page.waitForTimeout(50);
    state = await mapState(page);
  }
  const loading = state.inViewTiles.filter((tile) => tile.state === 'loading');
  throw new Error(
    `In-view tile parsing did not settle; ${loading.length} of ` +
    `${state.inViewTiles.length} tiles remain loading.`
  );
}

async function waitForRenderedCamera(page, camera) {
  await page.evaluate(({ center, zoom }) => {
    const map = globalThis.__OCCUMED_MAP__;
    map.stop();
    if (typeof map.setRenderWorldCopies === 'function') {
      map.setRenderWorldCopies(zoom >= 3);
    }
    map.jumpTo({ center, zoom, bearing: 0, pitch: 0 });
  }, camera);
  await page.waitForFunction(({ center, zoom }) => {
    const map = globalThis.__OCCUMED_MAP__;
    if (!map) return false;
    const actual = map.getCenter();
    const longitudeError = Math.abs((((actual.lng - center[0]) + 540) % 360) - 180);
    return longitudeError < 0.01 &&
      Math.abs(actual.lat - center[1]) < 0.01 &&
      Math.abs(map.getZoom() - zoom) < 0.01;
  }, camera, { timeout: 30_000 });
  await pumpRenderFrames(page);
}

async function pumpRenderFrames(page, minimumFrames = 4, timeoutMs = 2_000) {
  await page.evaluate(({ minimumFrames, timeoutMs }) => new Promise((resolve) => {
    const map = globalThis.__OCCUMED_MAP__;
    let frames = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(repaint);
      clearTimeout(timeout);
      map.off('render', onRender);
      resolve();
    };
    const onRender = () => {
      frames += 1;
      if (frames >= minimumFrames) finish();
    };
    map.on('render', onRender);
    const repaint = setInterval(() => map.triggerRepaint(), 50);
    const timeout = setTimeout(finish, timeoutMs);
    map.triggerRepaint();
  }), { minimumFrames, timeoutMs });
}

async function mapState(page) {
  return page.evaluate(() => {
    const map = globalThis.__OCCUMED_MAP__;
    const style = map.getStyle();
    const tileManager = map.style?.tileManagers?.['occumed-open'];
    const sourceIds = Object.keys(style.sources || {}).sort();
    const sourceLayers = new Set();
    const width = map.getContainer().clientWidth;
    const height = map.getContainer().clientHeight;
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const x = ((column + 0.5) / 3) * width;
        const y = ((row + 0.5) / 3) * height;
        const features = map.queryRenderedFeatures([
          [Math.max(0, x - 45), Math.max(0, y - 45)],
          [Math.min(width, x + 45), Math.min(height, y + 45)]
        ]);
        for (const feature of features) {
          if (feature.source === 'occumed-open' && feature.sourceLayer) {
            sourceLayers.add(feature.sourceLayer);
          }
        }
      }
    }
    return {
      sourceIds,
      sourceLayers: [...sourceLayers].sort(),
      center: [map.getCenter().lng, map.getCenter().lat],
      zoom: map.getZoom(),
      moving: map.isMoving(),
      styleLoaded: map.isStyleLoaded(),
      inViewTiles: tileManager?._inViewTiles?.getAllIds?.().map((id) => {
        const tile = tileManager._inViewTiles.getTileById(id);
        return {
          z: tile?.tileID?.canonical?.z,
          x: tile?.tileID?.canonical?.x,
          y: tile?.tileID?.canonical?.y,
          state: tile?.state,
          hasData: Boolean(tile?.hasData?.())
        };
      }) || []
    };
  });
}

async function analyzeScreenshot(_page, screenshot, zoom) {
  const { data, width, height } = PNG.sync.read(screenshot);
  const offset = (x, y) => (y * width + x) * 4;
  const delta = (left, right) =>
    Math.abs(data[left] - data[right]) +
    Math.abs(data[left + 1] - data[right + 1]) +
    Math.abs(data[left + 2] - data[right + 2]);
  const luma = (value) =>
    (data[value] * 299 + data[value + 1] * 587 + data[value + 2] * 114) / 1_000;
  const waterLike = (value) =>
    data[value + 2] >= 170 &&
    data[value + 1] >= 125 &&
    data[value + 2] - data[value] >= 35 &&
    data[value + 2] - data[value + 1] >= 20;
  const surfaceLike = (value) =>
    data[value + 3] >= 250 && luma(value) >= 75 && luma(value) <= 245;

  const histogram = new Map();
  let sampled = 0;
  let nonDark = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const value = offset(x, y);
      const key =
        ((data[value] >> 4) << 8) |
        ((data[value + 1] >> 4) << 4) |
        (data[value + 2] >> 4);
      histogram.set(key, (histogram.get(key) || 0) + 1);
      sampled += 1;
      if (luma(value) > 25) nonDark += 1;
    }
  }
  let dominantKey = 0;
  let dominantCount = 0;
  for (const [key, count] of histogram) {
    if (count > dominantCount) {
      dominantKey = key;
      dominantCount = count;
    }
  }
  const dominant = dominantCount / sampled;
  const dominantColor = [
    ((dominantKey >> 8) & 0x0f) * 16 + 8,
    ((dominantKey >> 4) & 0x0f) * 16 + 8,
    (dominantKey & 0x0f) * 16 + 8
  ];

  function scanVertical(x, predicate) {
    let best = { start: 0, end: 0, length: 0 };
    let start = 0;
    let length = 0;
    let gaps = 0;
    for (let y = 2; y < height - 2; y += 1) {
      const accepted = predicate(offset(x - 1, y), offset(x, y));
      if (accepted) {
        if (!length) start = y;
        length += 1 + gaps;
        gaps = 0;
      } else if (length && gaps < 2) {
        gaps += 1;
      } else {
        if (length > best.length) best = { start, end: y - gaps - 1, length };
        start = 0;
        length = 0;
        gaps = 0;
      }
    }
    if (length > best.length) best = { start, end: height - gaps - 2, length };
    return { axis: x, ...best };
  }

  function scanHorizontal(y, predicate) {
    let best = { start: 0, end: 0, length: 0 };
    let start = 0;
    let length = 0;
    let gaps = 0;
    for (let x = 2; x < width - 2; x += 1) {
      const accepted = predicate(offset(x, y - 1), offset(x, y));
      if (accepted) {
        if (!length) start = x;
        length += 1 + gaps;
        gaps = 0;
      } else if (length && gaps < 2) {
        gaps += 1;
      } else {
        if (length > best.length) best = { start, end: x - gaps - 1, length };
        start = 0;
        length = 0;
        gaps = 0;
      }
    }
    if (length > best.length) best = { start, end: width - gaps - 2, length };
    return { axis: y, ...best };
  }

  const strongEdge = (left, right) => {
    const difference = delta(left, right);
    return surfaceLike(left) && surfaceLike(right) && difference >= 45 && difference <= 260;
  };
  const waterEdge = (left, right) => {
    const difference = delta(left, right);
    return waterLike(left) && waterLike(right) && difference >= 5 && difference <= 75;
  };
  const footprintEdge = (left, right) => {
    const difference = delta(left, right);
    return surfaceLike(left) && surfaceLike(right) && difference >= 8 && difference <= 260;
  };

  const verticalStrong = [];
  const horizontalStrong = [];
  const verticalWater = [];
  const horizontalWater = [];
  const verticalFootprints = [];
  const horizontalFootprints = [];
  for (let x = 4; x < width - 4; x += 1) {
    const strong = scanVertical(x, strongEdge);
    if (strong.length >= height * 0.62) verticalStrong.push(strong);
    if (zoom >= 5) {
      const water = scanVertical(x, waterEdge);
      if (water.length >= height * 0.32) verticalWater.push(water);
      const footprint = scanVertical(x, footprintEdge);
      if (footprint.length >= 90) verticalFootprints.push(footprint);
    }
  }
  for (let y = 4; y < height - 4; y += 1) {
    const strong = scanHorizontal(y, strongEdge);
    if (strong.length >= width * 0.62) horizontalStrong.push(strong);
    if (zoom >= 5) {
      const water = scanHorizontal(y, waterEdge);
      if (water.length >= width * 0.32) horizontalWater.push(water);
      const footprint = scanHorizontal(y, footprintEdge);
      if (footprint.length >= 110) horizontalFootprints.push(footprint);
    }
  }

  function collapse(runs) {
    const ordered = [...runs].sort((left, right) => left.axis - right.axis || right.length - left.length);
    const output = [];
    for (const run of ordered) {
      const previous = output.at(-1);
      if (previous && run.axis - previous.axis <= 3) {
        if (run.length > previous.length) output[output.length - 1] = run;
      } else {
        output.push(run);
      }
    }
    return output;
  }

  const verticalCandidates = collapse(verticalFootprints).slice(0, 80);
  const horizontalCandidates = collapse(horizontalFootprints).slice(0, 80);
  let rectangles = 0;
  let rectangleBounds = null;
  function hasUniformInterior(left, right, top, bottom) {
    const counts = new Map();
    let total = 0;
    for (let y = top + 8; y < bottom - 8; y += 8) {
      for (let x = left + 8; x < right - 8; x += 8) {
        const value = offset(x, y);
        const key =
          ((data[value] >> 4) << 8) |
          ((data[value + 1] >> 4) << 4) |
          (data[value + 2] >> 4);
        counts.set(key, (counts.get(key) || 0) + 1);
        total += 1;
      }
    }
    return total > 40 && Math.max(...counts.values()) / total >= 0.68;
  }

  for (let leftIndex = 0; leftIndex < verticalCandidates.length; leftIndex += 1) {
    const left = verticalCandidates[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < verticalCandidates.length; rightIndex += 1) {
      const right = verticalCandidates[rightIndex];
      if (right.axis - left.axis < 90) continue;
      const topLimit = Math.max(left.start, right.start);
      const bottomLimit = Math.min(left.end, right.end);
      if (bottomLimit - topLimit < 90) continue;
      const top = horizontalCandidates.find((run) =>
        run.axis >= topLimit - 5 &&
        run.axis <= bottomLimit + 5 &&
        run.start <= left.axis + 5 &&
        run.end >= right.axis - 5
      );
      if (!top) continue;
      const bottom = horizontalCandidates.find((run) =>
        run.axis - top.axis >= 90 &&
        run.axis <= bottomLimit + 5 &&
        run.start <= left.axis + 5 &&
        run.end >= right.axis - 5
      );
      const candidateArea = bottom
        ? (right.axis - left.axis) * (bottom.axis - top.axis)
        : 0;
      if (
        bottom &&
        candidateArea >= width * height * 0.08 &&
        hasUniformInterior(left.axis, right.axis, top.axis, bottom.axis)
      ) {
        rectangles += 1;
        rectangleBounds = {
          left: left.axis,
          right: right.axis,
          top: top.axis,
          bottom: bottom.axis,
          areaRatio: candidateArea / (width * height)
        };
        break;
      }
    }
    if (rectangles) break;
  }

  const verticalSeams = collapse([...verticalStrong, ...verticalWater]);
  const horizontalSeams = collapse([...horizontalStrong, ...horizontalWater]);
  const blank = histogram.size < 12 || dominant > 0.985 || nonDark / sampled < 0.02;
  return {
    width,
    height,
    sampledPixels: sampled,
    quantizedColors: histogram.size,
    dominantColorRatio: dominant,
    dominantColor,
    nonDarkRatio: nonDark / sampled,
    blank,
    rectangularFootprints: rectangles,
    rectangleBounds,
    verticalSeams: verticalSeams.length,
    horizontalSeams: horizontalSeams.length,
    stretchedPolygons: rectangles,
    inconsistentNeighbors: verticalSeams.length + horizontalSeams.length,
    longestVerticalEdge: Math.max(
      0,
      ...verticalStrong.map((run) => run.length),
      ...verticalWater.map((run) => run.length)
    ),
    longestHorizontalEdge: Math.max(
      0,
      ...horizontalStrong.map((run) => run.length),
      ...horizontalWater.map((run) => run.length)
    )
  };
}

function validateSourceState(state, label, failures) {
  if (state.sourceIds.length !== 1 || state.sourceIds[0] !== 'occumed-open') {
    failures.push(`${label}: source switched to [${state.sourceIds.join(', ')}].`);
  }
}

function validatePixels(analysis, label, failures) {
  if (analysis.blank) failures.push(`${label}: blank rendered frame.`);
  if (analysis.rectangularFootprints) failures.push(`${label}: rectangular tile footprint detected.`);
  if (analysis.verticalSeams) failures.push(`${label}: vertical seam detected.`);
  if (analysis.horizontalSeams) failures.push(`${label}: horizontal seam detected.`);
  if (analysis.stretchedPolygons) failures.push(`${label}: stretched polygon detected.`);
  if (analysis.inconsistentNeighbors) failures.push(`${label}: neighboring tiles are inconsistent.`);
}

function applyFoundationBlankContract(pixels, state) {
  pixels.pixelBlank = pixels.blank;
  const oceanOnly =
    state.sourceLayers.length > 0 &&
    state.sourceLayers.every((layer) =>
      ['depth', 'water', 'water_name', 'waterway'].includes(layer)
    );
  const foundationLand = [232, 232, 216];
  const landColorDistance = pixels.dominantColor.reduce(
    (sum, channel, index) => sum + Math.abs(channel - foundationLand[index]),
    0
  );
  const uniformLand =
    state.sourceLayers.includes('land') &&
    pixels.dominantColorRatio >= 0.985 &&
    landColorDistance <= 30;
  if (oceanOnly || uniformLand) {
    pixels.blank = false;
    pixels.blankContract = oceanOnly ? 'ocean-foundation' : 'uniform-land-foundation';
  }
}

function validateRequiredLayers(name, state, failures) {
  const available = new Set(state.sourceLayers);
  const requireOne = (choices, label) => {
    if (!choices.some((choice) => available.has(choice))) {
      failures.push(`${name}: no rendered ${label} bucket (${choices.join(' or ')}).`);
    }
  };
  if (['pacific', 'antimeridian'].includes(name)) {
    requireOne(['depth', 'land'], 'foundation');
    return;
  }
  requireOne(['land', 'landcover'], 'land foundation');
  if (name.startsWith('fresno-')) {
    requireOne(['land'], 'prebuilt land foundation');
  }
  if (name === 'fresno-city' || name === 'fresno-street') {
    requireOne(['transportation', 'building', 'place'], 'regional cartography');
  }
}

function staticStateIsReady(name, state) {
  const available = new Set(state.sourceLayers);
  const hasOne = (choices) => choices.some((choice) => available.has(choice));
  if (['pacific', 'antimeridian'].includes(name)) {
    return hasOne(['depth', 'land']);
  }
  if (!hasOne(['land', 'landcover'])) return false;
  if (name.startsWith('fresno-') && !available.has('land')) return false;
  if (name === 'fresno-city' || name === 'fresno-street') {
    return hasOne(['transportation', 'building', 'place']);
  }
  return true;
}

async function waitForStaticState(page, name, timeoutMs = 30_000) {
  const started = Date.now();
  let state = await mapState(page);
  while (!staticStateIsReady(name, state) && Date.now() - started < timeoutMs) {
    await pumpRenderFrames(page, 3, 1_000);
    await page.waitForTimeout(100);
    state = await mapState(page);
  }
  return state;
}

const options = parseArguments(process.argv.slice(2));
const phase = options.phase || 'all';
if (!['all', 'static', 'motion'].includes(phase)) {
  throw new Error(`Unsupported validation phase: ${phase}`);
}
const manifest = path.resolve(options.manifest);
const targets = JSON.parse(await fs.readFile(path.resolve(options.targets), 'utf8'));
const outputDir = path.resolve(options['output-dir']);
await fs.mkdir(path.dirname(outputDir), { recursive: true });
await fs.mkdir(outputDir, { recursive: false });
const priorStaticReport = options['static-report']
  ? JSON.parse(await fs.readFile(path.resolve(options['static-report']), 'utf8'))
  : null;
if (phase === 'motion' && !priorStaticReport) {
  throw new Error('Motion-only validation requires --static-report.');
}
if (priorStaticReport && priorStaticReport.summary?.passed !== true) {
  throw new Error('The supplied static validation report did not pass.');
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  manifest,
  phase,
  staticReport: options['static-report'] ? path.resolve(options['static-report']) : null,
  viewport: VIEWPORT,
  failClosedCheck: null,
  staticViews: priorStaticReport?.staticViews || [],
  motionFrames: [],
  pageErrors: [],
  networkErrors: [],
  requestCancellations: [],
  tileResponses: [],
  failures: []
};

let validationServer;
let browser;
try {
  const failClosedServer = await startServer({
    manifest,
    port: 4317,
    allowPartial: false,
    logPath: path.join(outputDir, 'server-fail-closed.log')
  });
  try {
    const rejected = await waitForReadiness(failClosedServer.origin, 503);
    report.failClosedCheck = rejected;
  } finally {
    await stopServer(failClosedServer);
  }

  validationServer = await startServer({
    manifest,
    port: 4318,
    allowPartial: true,
    logPath: path.join(outputDir, 'server.log')
  });
  const ready = await waitForReadiness(validationServer.origin, 200);
  report.readiness = ready;

  browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  const outstandingTiles = new Set();
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') report.pageErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (request.url().includes('/tiles/')) outstandingTiles.add(request);
  });
  page.on('requestfinished', (request) => outstandingTiles.delete(request));
  page.on('requestfailed', (request) => {
    outstandingTiles.delete(request);
    const failure = request.failure()?.errorText || 'request failed';
    const entry = { url: request.url(), failure };
    if (failure.includes('ERR_ABORTED')) report.requestCancellations.push(entry);
    else report.networkErrors.push(entry);
  });
  page.on('response', (response) => {
    if (response.url().includes('/tiles/')) {
      report.tileResponses.push({
        url: response.url(),
        status: response.status()
      });
    }
    if (
      response.url().startsWith(validationServer.origin) &&
      response.status() >= 400
    ) {
      report.networkErrors.push({
        url: response.url(),
        status: response.status()
      });
    }
  });

  await page.goto(validationServer.origin, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });
  await page.addStyleTag({
    content: '.map-header,.maplibregl-control-container{display:none!important}'
  });
  await page.waitForFunction(() => {
    const map = globalThis.__OCCUMED_MAP__;
    return map && map.getStyle()?.sources?.['occumed-open'];
  }, { timeout: 60_000 });
  await page.evaluate(() => {
    const map = globalThis.__OCCUMED_MAP__;
    if (typeof map.setPixelRatio === 'function') map.setPixelRatio(1);
    map.resize();
    map.triggerRepaint();
  });
  report.validatorPixelRatio = await page.evaluate(() =>
    globalThis.__OCCUMED_MAP__.getPixelRatio?.() || 1
  );

  if (phase !== 'motion') {
  for (const view of targets.staticViews) {
    await waitForRenderedCamera(page, view);
    await page.waitForTimeout(200);
    await waitForRequestSettlement(outstandingTiles);
    await pumpRenderFrames(page);
    const state = await waitForStaticState(page, view.name);
    const screenshot = await page.screenshot({
      path: path.join(outputDir, `static-${safeName(view.name)}.png`)
    });
    const pixels = await analyzeScreenshot(page, screenshot, state.zoom);
    applyFoundationBlankContract(pixels, state);
    validateSourceState(state, `static ${view.name}`, report.failures);
    validateRequiredLayers(view.name, state, report.failures);
    validatePixels(pixels, `static ${view.name}`, report.failures);
    report.staticViews.push({
      ...view,
      state,
      pixels,
      file: `static-${safeName(view.name)}.png`
    });
    console.log(
      `[static] ${view.name}: sources=${state.sourceIds.length}, ` +
      `layers=${state.sourceLayers.length}, seams=${pixels.verticalSeams + pixels.horizontalSeams}, ` +
      `rectangles=${pixels.rectangularFootprints}, blank=${pixels.blank}.`
    );
  }
  }

  // The nine static views intentionally traverse the complete zoom pyramid and
  // can leave hundreds of megabytes of decoded vector buckets in a software
  // browser. Start the motion phase with a fresh page and an empty renderer
  // cache; HTTP and PMTiles inputs remain unchanged.
  if (phase === 'all') {
    await waitForRequestSettlement(outstandingTiles);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.addStyleTag({
      content: '.map-header,.maplibregl-control-container{display:none!important}'
    });
    await page.waitForFunction(() => {
      const map = globalThis.__OCCUMED_MAP__;
      return map && map.getStyle()?.sources?.['occumed-open'];
    }, { timeout: 60_000 });
    await page.evaluate(() => {
      const map = globalThis.__OCCUMED_MAP__;
      if (typeof map.setPixelRatio === 'function') map.setPixelRatio(1);
      map.resize();
      map.triggerRepaint();
    });
    await page.waitForTimeout(200);
    await waitForRequestSettlement(outstandingTiles);
  }

  if (phase !== 'static') {
  const selectedFrames = options.motion
    ? targets.validationFrames.filter((frame) => frame.motion === options.motion)
    : targets.validationFrames;
  const framesByMotion = Map.groupBy(selectedFrames, (frame) => frame.motion);
  for (const [motionName, frames] of framesByMotion) {
    const ordered = [...frames].sort((left, right) => left.index - right.index);
    const start = ordered[0];
    await waitForRenderedCamera(page, start);
    await page.waitForTimeout(200);
    await waitForRequestSettlement(outstandingTiles);
    await pumpRenderFrames(page);
    await waitForInViewTileSettlement(page);

    for (let index = 0; index < ordered.length; index += 1) {
      if (index > 0) {
        await page.evaluate(({ frame, duration }) => new Promise((resolve) => {
          const map = globalThis.__OCCUMED_MAP__;
          const finish = () => {
            map.off('moveend', finish);
            resolve();
          };
          map.on('moveend', finish);
          map.easeTo({
            center: frame.center,
            zoom: frame.zoom,
            bearing: 0,
            pitch: 0,
            duration,
            easing: (value) => value
          });
        }), {
          frame: ordered[index],
          duration: MOTION_DURATION_MS / (ordered.length - 1)
        });
        await waitForRequestSettlement(outstandingTiles);
      }

      const state = await waitForInViewTileSettlement(page);
      const filename = `motion-${safeName(motionName)}-${String(index).padStart(2, '0')}.png`;
      const screenshot = await page.screenshot({ path: path.join(outputDir, filename) });
      const pixels = await analyzeScreenshot(page, screenshot, state.zoom);
      applyFoundationBlankContract(pixels, state);
      validateSourceState(state, `motion ${motionName} frame ${index}`, report.failures);
      validatePixels(pixels, `motion ${motionName} frame ${index}`, report.failures);
      report.motionFrames.push({
        motion: motionName,
        index,
        expectedCamera: ordered[index],
        state,
        pixels,
        file: filename
      });
    }
    console.log(`[motion] ${motionName}: ${ordered.length} exact-camera transition frames captured.`);
  }
  }

  if (report.pageErrors.length) {
    report.failures.push(`${report.pageErrors.length} browser/page errors occurred.`);
  }
  if (report.networkErrors.length) {
    report.failures.push(`${report.networkErrors.length} network/resource errors occurred.`);
  }
  report.summary = {
    staticViewCount: report.staticViews.length,
    motionFrameCount: report.motionFrames.length,
    blankFrames: [...report.staticViews, ...report.motionFrames]
      .filter((capture) => capture.pixels.blank).length,
    rectangularFootprints: [...report.staticViews, ...report.motionFrames]
      .reduce((sum, capture) => sum + capture.pixels.rectangularFootprints, 0),
    verticalSeams: [...report.staticViews, ...report.motionFrames]
      .reduce((sum, capture) => sum + capture.pixels.verticalSeams, 0),
    horizontalSeams: [...report.staticViews, ...report.motionFrames]
      .reduce((sum, capture) => sum + capture.pixels.horizontalSeams, 0),
    stretchedPolygons: [...report.staticViews, ...report.motionFrames]
      .reduce((sum, capture) => sum + capture.pixels.stretchedPolygons, 0),
    inconsistentNeighbors: [...report.staticViews, ...report.motionFrames]
      .reduce((sum, capture) => sum + capture.pixels.inconsistentNeighbors, 0),
    sourceSwitches: [...report.staticViews, ...report.motionFrames]
      .filter((capture) =>
        capture.state.sourceIds.length !== 1 ||
        capture.state.sourceIds[0] !== 'occumed-open'
      ).length,
    pageErrors: report.pageErrors.length,
    networkErrors: report.networkErrors.length,
    requestCancellations: report.requestCancellations.length,
    passed: report.failures.length === 0
  };
} catch (error) {
  report.failures.push(error?.stack || error?.message || String(error));
} finally {
  await browser?.close().catch(() => {});
  await stopServer(validationServer);
  await fs.writeFile(
    path.join(outputDir, 'immutable-visual-report.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
}

if (report.failures.length) {
  console.error('Immutable visual validation failed:');
  for (const failure of report.failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `Immutable visual validation passed: ${report.summary.staticViewCount} static views, ` +
  `${report.summary.motionFrameCount} exact-camera motion checkpoints, one source, and zero visual/network defects.`
);
