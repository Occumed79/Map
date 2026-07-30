#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const [inputDir, outputPath, expectedText = '51'] = process.argv.slice(2);
if (!inputDir || !outputPath) {
  throw new Error('Usage: node scripts/aggregate-offline-owner-manifests.mjs INPUT_DIR OUTPUT.json [EXPECTED_FAMILIES]');
}
const expectedFamilies = Number(expectedText);
const files = [];
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (/occumed-owner-.*\.manifest\.json$/.test(entry.name)) files.push(absolute);
  }
}
await walk(inputDir);

const families = [];
const cellOwners = new Map();
for (const filename of files.sort()) {
  const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
  families.push(manifest);
  for (const partition of manifest.partitions || []) {
    for (const cell of partition.cells || []) {
      const key = `${cell.z}/${cell.x}/${cell.y}`;
      const list = cellOwners.get(key) || [];
      list.push({ family: manifest.family, asset: partition.asset || partition.pmtiles || partition.mbtiles });
      cellOwners.set(key, list);
    }
  }
}

const conflicts = [...cellOwners.entries()]
  .filter(([, owners]) => owners.length > 1)
  .map(([cell, owners]) => ({ cell, owners }))
  .sort((a, b) => a.cell.localeCompare(b.cell));
const familyIds = new Set(families.map((manifest) => manifest.family));
const duplicateFamilies = families
  .map((manifest) => manifest.family)
  .filter((family, index, all) => all.indexOf(family) !== index);

const aggregate = {
  generatedAt: new Date().toISOString(),
  version: 1,
  architecture: 'immutable-offline-owner-partitions',
  foundation: {
    overviewAsset: 'occumed-world-overview.pmtiles',
    surfaceAsset: 'occumed-world-surface.pmtiles',
    minZoom: 0,
    maxZoom: 10
  },
  regionalRoutingZoom: 11,
  expectedFamilyCount: expectedFamilies,
  completedFamilyCount: familyIds.size,
  duplicateFamilies: [...new Set(duplicateFamilies)].sort(),
  conflictCellCount: conflicts.length,
  conflicts,
  activationAllowed: familyIds.size === expectedFamilies && !duplicateFamilies.length && !conflicts.length,
  families: families.sort((a, b) => a.family.localeCompare(b.family))
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
console.log(`Aggregated ${familyIds.size}/${expectedFamilies} families with ${conflicts.length} conflicting owner cells.`);
if (!aggregate.activationAllowed) process.exitCode = 1;
