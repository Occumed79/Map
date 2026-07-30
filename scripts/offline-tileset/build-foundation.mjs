#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${key || '<end>'}.`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ['plan', 'targets', 'input-report', 'output-dir']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  return result;
}

async function runNode(script, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${path.basename(script)} terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`${path.basename(script)} exited with ${code}.`));
      else resolve();
    });
  });
}

const options = parseArguments(process.argv.slice(2));
const [plan, targets, inputReport] = await Promise.all([
  fs.readFile(path.resolve(options.plan), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(options.targets), 'utf8').then(JSON.parse),
  fs.readFile(path.resolve(options['input-report']), 'utf8').then(JSON.parse)
]);
if (plan.planVersion !== targets.planVersion || plan.planVersion !== inputReport.planVersion) {
  throw new Error('Plan, targets, and localized inputs do not share one immutable plan version.');
}
const inputByAsset = new Map(inputReport.inputs.map((input) => [input.asset, input.path]));
const overview = inputByAsset.get(plan.inputs.overview.asset);
const surface = inputByAsset.get(plan.inputs.surface.asset);
if (!overview || !surface) throw new Error('Localized overview or surface input is missing.');

const outputDir = path.resolve(options['output-dir']);
await fs.mkdir(path.join(outputDir, 'reports'), { recursive: true });
await fs.mkdir(path.join(outputDir, 'work'), { recursive: true });
const output = path.join(outputDir, 'foundation.pmtiles');
const report = path.join(outputDir, 'reports/foundation.json');
if (await fs.stat(output).catch(() => null) || await fs.stat(report).catch(() => null)) {
  throw new Error('Immutable foundation output already exists.');
}
await runNode(path.join(scriptDirectory, 'build-archive.mjs'), [
  '--targets', path.resolve(options.targets),
  '--target-name', 'foundation',
  '--overview', overview,
  '--surface', surface,
  '--output', output,
  '--report', report,
  '--workdir', path.join(outputDir, 'work/foundation'),
  '--manifest-file', 'foundation.pmtiles',
  '--foundation-max-zoom', String(plan.routingZoom),
  '--concurrency', String(options.concurrency || 4)
]);
