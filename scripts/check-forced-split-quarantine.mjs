#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const configPath = path.join(root, 'config/forced-split-families.json');
const splitPattern = /--r\d+-c\d+(?:-s\d+)?(?:\.pmtiles)?$/;
const failures = [];

const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const families = Array.isArray(config.families) ? config.families : [];
const uniqueFamilies = new Set(families.map((family) => family.id));

if (families.length !== 51 || config.splitFamilyCount !== 51) {
  failures.push(`Expected 51 published split families; found ${families.length}.`);
}
if (uniqueFamilies.size !== families.length) {
  failures.push('Forced-split family configuration contains duplicate IDs.');
}
if (config.splitAssetCount !== 262) {
  failures.push(`Expected 262 published split assets; found ${config.splitAssetCount}.`);
}
if (!uniqueFamilies.has('sul') || !uniqueFamilies.has('sudeste') || !uniqueFamilies.has('argentina')) {
  failures.push('South America split families are missing from quarantine configuration.');
}

const manifestCandidates = [
  'public/tiles/world-virtual-manifest.json',
  'dist/server-assets/world-virtual-manifest.json',
  'dist/virtual-assets/world-virtual-manifest.json',
  '.world-build/world-virtual-manifest.json'
];

for (const relativePath of manifestCandidates) {
  const filePath = path.join(root, relativePath);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    failures.push(`Cannot read ${relativePath}: ${error.message}`);
    continue;
  }

  const unsafeRegions = (manifest.regions || []).filter((region) =>
    splitPattern.test(String(region.id || '')) || splitPattern.test(String(region.asset || ''))
  );
  if (unsafeRegions.length) {
    failures.push(
      `${relativePath} actively routes ${unsafeRegions.length} forced grid-split children: ${unsafeRegions
        .slice(0, 10)
        .map((region) => region.asset || region.id)
        .join(', ')}`
    );
  }
}

const manifestBuilder = await fs.readFile(path.join(root, 'scripts/build-world-manifest.mjs'), 'utf8');
if (!manifestBuilder.includes('FORCED_GRID_SPLIT_PATTERN') || !manifestBuilder.includes('forced-grid-split-assets-disabled')) {
  failures.push('World manifest builder does not enforce forced grid-split quarantine.');
}

if (failures.length) {
  console.error('Forced grid-split quarantine validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Forced grid-split quarantine validated: 51 published families / 262 child archives recorded, South America included, and no generated active manifest routes --r#-c# assets.');
