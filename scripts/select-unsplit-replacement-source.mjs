#!/usr/bin/env node

import fs from 'node:fs/promises';

const [family, planPath, outputPath] = process.argv.slice(2);
if (!family || !planPath || !outputPath) {
  throw new Error('Usage: node scripts/select-unsplit-replacement-source.mjs <family> <plan.json> <output.json>');
}

const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
const entries = Array.isArray(plan.include) ? plan.include : [];
const normalizedFamily = family.replace(/^occumed-/, '').replace(/\.pmtiles$/, '');
const candidates = entries.filter((entry) =>
  [entry.id, entry.slug, entry.source_region_id].some((value) => String(value || '') === normalizedFamily)
);

if (candidates.length !== 1) {
  const nearby = entries
    .filter((entry) => [entry.id, entry.slug, entry.source_region_id].some((value) => String(value || '').includes(normalizedFamily)))
    .slice(0, 20)
    .map((entry) => entry.id);
  throw new Error(
    `Expected exactly one unsplit Geofabrik source for ${family}; found ${candidates.length}. Nearby IDs: ${nearby.join(', ') || 'none'}`
  );
}

const source = candidates[0];
if (!source.pbf_url || source.extract_bbox) {
  throw new Error(`Replacement source ${source.id} is not an unsplit parent PBF.`);
}

await fs.writeFile(outputPath, `${JSON.stringify(source, null, 2)}\n`);
console.log(`Selected unsplit replacement source ${source.id}: ${source.pbf_url}`);
