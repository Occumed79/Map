#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const planner = spawnSync(
  process.execPath,
  ['scripts/plan-world-shards.mjs', ...process.argv.slice(2)],
  { encoding: 'utf8', env: process.env }
);

if (planner.stderr) process.stderr.write(planner.stderr);
if (planner.status !== 0) {
  process.stderr.write(planner.stdout || '');
  process.exit(planner.status ?? 1);
}

const plan = JSON.parse(planner.stdout);
const forcedSplits = new Map([
  ['northwestern-fed-district--r1-c1', { rows: 2, columns: 4 }],
  ['far-eastern-fed-district', { rows: 2, columns: 4 }],
  ['siberian-fed-district--r1-c1', { rows: 2, columns: 4 }],
  ['ural-fed-district', { rows: 2, columns: 4 }]
]);

function splitTarget(target, rows, columns) {
  const longitudeStep = (target.east - target.west) / columns;
  const latitudeStep = (target.north - target.south) / rows;
  const children = [];

  for (let row = 0; row < rows; row += 1) {
    const south = Number((target.south + latitudeStep * row).toFixed(6));
    const north = Number(
      (row === rows - 1 ? target.north : target.south + latitudeStep * (row + 1)).toFixed(6)
    );
    for (let column = 0; column < columns; column += 1) {
      const west = Number((target.west + longitudeStep * column).toFixed(6));
      const east = Number(
        (column === columns - 1 ? target.east : target.west + longitudeStep * (column + 1)).toFixed(6)
      );
      const suffix = `--s2-r${row + 1}-c${column + 1}`;
      const id = `${target.id}${suffix}`;
      const slug = `${target.slug}${suffix}`;
      children.push({
        ...target,
        id,
        slug,
        name: `${target.name} split ${row + 1}.${column + 1}`,
        extract_bbox: `${west},${south},${east},${north}`,
        west,
        south,
        east,
        north,
        asset_name: `occumed-${slug}.pmtiles`,
        metadata_name: `occumed-${slug}.json`,
        oversized_parent_id: target.id
      });
    }
  }
  return children;
}

for (const [targetId, dimensions] of forcedSplits) {
  const target = (plan.include || []).find((region) => region.id === targetId);
  if (!target) continue;
  const children = splitTarget(target, dimensions.rows, dimensions.columns);
  plan.include = plan.include
    .filter((region) => region.id !== targetId)
    .concat(children);
  process.stderr.write(`Replacing oversized ${targetId} with ${children.length} child shards.\n`);
}

plan.include.sort((left, right) => left.id.localeCompare(right.id));
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
