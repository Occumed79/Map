#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const FOUNDATION_WORLD_MAX_ZOOM = 6;

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
  for (const required of ['plan', 'targets', 'input-report', 'output-dir']) {
    if (!result[required]) throw new Error(`Missing required --${required}.`);
  }
  return result;
}

async function runNode(script, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${path.basename(script)} terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`${path.basename(script)} exited with ${code}.`));
      else resolve();
    });
  });
}

const options = parseArguments(process.argv.slice(2));
const planPath = path.resolve(options.plan);
const targetsPath = path.resolve(options.targets);
const inputReportPath = path.resolve(options['input-report']);
const outputDir = path.resolve(options['output-dir']);
const stat = await fs.stat(outputDir).catch(() => null);
if (stat) throw new Error(`Representative output directory already exists: ${outputDir}`);
await fs.mkdir(path.join(outputDir, 'owners'), { recursive: true });
await fs.mkdir(path.join(outputDir, 'reports'), { recursive: true });
await fs.mkdir(path.join(outputDir, 'work'), { recursive: true });

const [plan, targets, inputReport] = await Promise.all([
  fs.readFile(planPath, 'utf8').then(JSON.parse),
  fs.readFile(targetsPath, 'utf8').then(JSON.parse),
  fs.readFile(inputReportPath, 'utf8').then(JSON.parse)
]);
if (plan.planVersion !== inputReport.planVersion) {
  throw new Error('Localized inputs do not match the owner plan.');
}
const inputByAsset = new Map(inputReport.inputs.map((input) => [input.asset, input.path]));
const overview = inputByAsset.get(plan.inputs.overview.asset);
const surface = inputByAsset.get(plan.inputs.surface.asset);
if (!overview || !surface) throw new Error('Localized overview or surface input is missing.');

const buildScript = path.join(scriptDirectory, 'build-archive.mjs');
const finalizeScript = path.join(scriptDirectory, 'finalize-manifest.mjs');
const startedAt = performance.now();
const foundationOutput = path.join(outputDir, 'foundation.pmtiles');
const foundationReport = path.join(outputDir, 'reports/foundation.json');
await runNode(buildScript, [
  '--targets', targetsPath,
  '--target-name', 'foundation',
  '--overview', overview,
  '--surface', surface,
  '--output', foundationOutput,
  '--report', foundationReport,
  '--workdir', path.join(outputDir, 'work/foundation'),
  '--manifest-file', 'foundation.pmtiles',
  '--foundation-max-zoom', String(FOUNDATION_WORLD_MAX_ZOOM)
]);

const ownerReports = [];
for (const selected of targets.selectedOwners) {
  const planOwner = plan.owners.find((owner) => owner.id === selected.id);
  if (!planOwner) throw new Error(`Selected owner is not in the locked plan: ${selected.id}`);
  const ownerOutput = path.join(outputDir, `owners/${selected.id}.pmtiles`);
  const ownerReport = path.join(outputDir, `reports/${selected.id}.json`);
  const regionalArgs = [];
  const requiredNames = new Set(
    (selected.requiredCandidates || planOwner.candidates).map((candidate) => candidate.asset)
  );
  for (const candidate of planOwner.candidates.filter((item) => requiredNames.has(item.asset))) {
    const filename = inputByAsset.get(candidate.asset);
    if (!filename) throw new Error(`Localized owner input is missing: ${candidate.asset}`);
    regionalArgs.push('--regional', `${candidate.asset}=${filename}`);
  }
  await runNode(buildScript, [
    '--targets', targetsPath,
    '--target-name', selected.id,
    '--overview', overview,
    '--surface', surface,
    ...regionalArgs,
    '--output', ownerOutput,
    '--report', ownerReport,
    '--workdir', path.join(outputDir, `work/${selected.id}`),
    '--manifest-file', `owners/${selected.id}.pmtiles`,
    '--owner-id', selected.id,
    '--owner-prefix', `${selected.prefix.z}/${selected.prefix.x}/${selected.prefix.y}`
  ]);
  ownerReports.push(ownerReport);
}

const manifestPath = path.join(outputDir, 'manifest.json');
await runNode(finalizeScript, [
  '--plan', planPath,
  '--foundation', foundationReport,
  ...ownerReports.flatMap((report) => ['--owner', report]),
  '--output', manifestPath
]);
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const durationSeconds = (performance.now() - startedAt) / 1_000;
const buildReport = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  artifactVersion: manifest.artifactVersion,
  durationSeconds,
  totalBytes: manifest.totalBytes,
  addressedTiles: targets.totalAddressedTiles,
  foundationReport: path.relative(outputDir, foundationReport),
  ownerReports: ownerReports.map((report) => path.relative(outputDir, report)),
  manifest: path.relative(outputDir, manifestPath)
};
await fs.writeFile(
  path.join(outputDir, 'representative-build-report.json'),
  `${JSON.stringify(buildReport, null, 2)}\n`
);
console.log(
  `Representative immutable tileset ${manifest.artifactVersion} built in ` +
  `${durationSeconds.toFixed(1)} seconds (${manifest.totalBytes} bytes).`
);
