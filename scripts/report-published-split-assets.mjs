#!/usr/bin/env node

import fs from 'node:fs/promises';

const [repository = process.env.GITHUB_REPOSITORY, tag = 'occumed-world-v1', jsonOutput = 'audit/published-split-assets.json', markdownOutput = 'audit/published-split-assets.md'] = process.argv.slice(2);
if (!repository) throw new Error('Repository is required.');

const token = process.env.GITHUB_TOKEN || '';
const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {})
};

async function githubJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

const release = await githubJson(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
const assets = [];
for (let page = 1; ; page += 1) {
  const batch = await githubJson(`https://api.github.com/repos/${repository}/releases/${release.id}/assets?per_page=100&page=${page}`);
  assets.push(...batch);
  if (batch.length < 100) break;
}

const splitPattern = /^occumed-(.+)--r\d+-c\d+(?:-s\d+)?\.pmtiles$/;
const families = new Map();
for (const asset of assets) {
  const match = asset.name.match(splitPattern);
  if (!match) continue;
  const parent = match[1];
  const family = families.get(parent) || { parent, assets: [], totalBytes: 0 };
  family.assets.push({ name: asset.name, size: Number(asset.size || 0), state: asset.state, downloadCount: asset.download_count });
  family.totalBytes += Number(asset.size || 0);
  families.set(parent, family);
}

const rows = [...families.values()]
  .map((family) => ({
    ...family,
    assetCount: family.assets.length,
    assets: family.assets.sort((a, b) => a.name.localeCompare(b.name))
  }))
  .sort((a, b) => b.assetCount - a.assetCount || a.parent.localeCompare(b.parent));

const result = {
  generatedAt: new Date().toISOString(),
  repository,
  releaseTag: tag,
  releaseId: release.id,
  releaseName: release.name,
  totalReleaseAssets: assets.length,
  splitFamilyCount: rows.length,
  splitAssetCount: rows.reduce((sum, row) => sum + row.assetCount, 0),
  families: rows
};

const gib = (bytes) => (bytes / 1024 ** 3).toFixed(2);
const markdown = [
  '# Published Forced-Split Assets',
  '',
  `Generated: ${result.generatedAt}`,
  '',
  `- Release: \`${tag}\``,
  `- Total release assets: **${assets.length}**`,
  `- Published split families: **${rows.length}**`,
  `- Published split PMTiles assets: **${result.splitAssetCount}**`,
  '',
  '| Parent name inferred from published asset | Published children | Combined size |',
  '|---|---:|---:|',
  ...rows.map((row) => `| \`${row.parent}\` | ${row.assetCount} | ${gib(row.totalBytes)} GiB |`),
  '',
  ...rows.flatMap((row) => [
    `## ${row.parent}`,
    '',
    ...row.assets.map((asset) => `- \`${asset.name}\` — ${(asset.size / 1024 ** 2).toFixed(2)} MiB — ${asset.state}`),
    ''
  ])
].join('\n');

await fs.mkdir(jsonOutput.split('/').slice(0, -1).join('/') || '.', { recursive: true });
await fs.writeFile(jsonOutput, `${JSON.stringify(result, null, 2)}\n`);
await fs.writeFile(markdownOutput, `${markdown}\n`);
console.log(markdown);
