#!/usr/bin/env node

import fs from 'node:fs/promises';

const PINNED_PLAN_PATH = 'diagnostics/world-release-inventory/canonical-world-plan.json';
const plan = JSON.parse(await fs.readFile(PINNED_PLAN_PATH, 'utf8'));

const forcedSplits = new Map([
  ['northwestern-fed-district--r1-c1', { rows: 2, columns: 4, generation: 's2' }],
  ['far-eastern-fed-district', { rows: 2, columns: 4, generation: 's3', antimeridian: true }],
  ['siberian-fed-district--r1-c1', { rows: 2, columns: 4, generation: 's2' }],
  ['ural-fed-district', { rows: 2, columns: 4, generation: 's2' }]
]);

function round(value) {
  return Number(value.toFixed(6));
}

function longitudeSegments(westUnwrapped, eastUnwrapped) {
  if (westUnwrapped < 180 && eastUnwrapped > 180) {
    return [
      [westUnwrapped, 180],
      [-180, eastUnwrapped - 360]
    ];
  }
  if (westUnwrapped >= 180) return [[westUnwrapped - 360, eastUnwrapped - 360]];
  return [[westUnwrapped, eastUnwrapped]];
}

function splitTarget(target, config) {
  const { rows, columns, generation, antimeridian = false } = config;
  const eastUnwrapped = antimeridian && target.east < target.west ? target.east + 360 : target.east;
  const longitudeStep = (eastUnwrapped - target.west) / columns;
  const latitudeStep = (target.north - target.south) / rows;
  const children = [];

  for (let row = 0; row < rows; row += 1) {
    const south = round(target.south + latitudeStep * row);
    const north = round(row === rows - 1 ? target.north : target.south + latitudeStep * (row + 1));

    for (let column = 0; column < columns; column += 1) {
      const westUnwrapped = target.west + longitudeStep * column;
      const eastCellUnwrapped = column === columns - 1
        ? eastUnwrapped
        : target.west + longitudeStep * (column + 1);
      const segments = antimeridian
        ? longitudeSegments(westUnwrapped, eastCellUnwrapped)
        : [[westUnwrapped, eastCellUnwrapped]];

      segments.forEach(([segmentWest, segmentEast], segmentIndex) => {
        const segmentSuffix = segments.length > 1 ? `-s${segmentIndex + 1}` : '';
        const suffix = `--${generation}-r${row + 1}-c${column + 1}${segmentSuffix}`;
        const id = `${target.id}${suffix}`;
        const slug = `${target.slug}${suffix}`;
        const west = round(segmentWest);
        const east = round(segmentEast);

        children.push({
          ...target,
          id,
          slug,
          name: `${target.name} split ${row + 1}.${column + 1}${segmentSuffix}`,
          extract_bbox: `${west},${south},${east},${north}`,
          west,
          south,
          east,
          north,
          asset_name: `occumed-${slug}.pmtiles`,
          metadata_name: `occumed-${slug}.json`,
          oversized_parent_id: target.id
        });
      });
    }
  }

  return children;
}

for (const [targetId, config] of forcedSplits) {
  const target = (plan.include || []).find((region) => region.id === targetId);
  if (!target) throw new Error(`Pinned canonical target is missing: ${targetId}`);
  const children = splitTarget(target, config);
  plan.include = plan.include
    .filter((region) => region.id !== targetId)
    .concat(children);
  process.stderr.write(`Pinned replacement: ${targetId} -> ${children.length} child shards.\n`);
}

plan.include.sort((left, right) => left.id.localeCompare(right.id));
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
