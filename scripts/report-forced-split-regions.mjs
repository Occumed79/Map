#!/usr/bin/env node

import fs from 'node:fs/promises';

const [planPath = 'audit/world-plan.json', jsonPath = 'audit/forced-split-regions.json', markdownPath = 'audit/forced-split-regions.md'] = process.argv.slice(2);
const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
const grouped = new Map();

for (const region of plan.include || []) {
  if (!region.extract_bbox || !region.source_region_id || region.source_region_id === region.id) continue;
  const key = region.source_region_id;
  const group = grouped.get(key) || {
    source_region_id: key,
    continent: region.continent,
    source_size_bytes: region.source_size_bytes,
    child_count: 0,
    children: []
  };
  group.child_count += 1;
  group.children.push({
    id: region.id,
    asset_name: region.asset_name,
    extract_bbox: region.extract_bbox,
    bounds: [region.west, region.south, region.east, region.north]
  });
  grouped.set(key, group);
}

const families = [...grouped.values()]
  .map((group) => ({ ...group, children: group.children.sort((a, b) => a.id.localeCompare(b.id)) }))
  .sort((a, b) => (b.source_size_bytes || 0) - (a.source_size_bytes || 0) || a.source_region_id.localeCompare(b.source_region_id));

const report = {
  generated_at: new Date().toISOString(),
  direct_split_limit_bytes: 850_000_000,
  forced_split_family_count: families.length,
  forced_split_child_count: families.reduce((sum, family) => sum + family.child_count, 0),
  families
};

const formatGiB = (bytes) => Number.isFinite(bytes) ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : 'unknown';
const lines = [
  '# Forced Grid-Split Region Audit',
  '',
  `Generated: ${report.generated_at}`,
  '',
  `- Forced-split parent families: **${report.forced_split_family_count}**`,
  `- Generated child archives: **${report.forced_split_child_count}**`,
  `- Split threshold: **${formatGiB(report.direct_split_limit_bytes)}**`,
  '',
  '| Parent source region | Continent | Source size | Child archives |',
  '|---|---:|---:|---:|',
  ...families.map((family) => `| \`${family.source_region_id}\` | ${family.continent || ''} | ${formatGiB(family.source_size_bytes)} | ${family.child_count} |`),
  '',
  '## Child assets by parent',
  ''
];
for (const family of families) {
  lines.push(`### ${family.source_region_id}`, '', `Source size: ${formatGiB(family.source_size_bytes)}  `, `Children: ${family.child_count}`, '');
  for (const child of family.children) lines.push(`- \`${child.asset_name}\` — bbox \`${child.extract_bbox}\``);
  lines.push('');
}

await fs.mkdir('audit', { recursive: true });
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(markdownPath, `${lines.join('\n')}\n`);
console.log(`Identified ${report.forced_split_family_count} forced-split parent families and ${report.forced_split_child_count} child archives.`);
