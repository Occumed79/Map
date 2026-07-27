import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const reportPath = path.join(root, 'public/style/compatibility-report.json');

const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));

const expressionOperators = new Set([
  'array',
  'at',
  'case',
  'coalesce',
  'concat',
  'format',
  'get',
  'interpolate',
  'let',
  'literal',
  'match',
  'step',
  'to-string',
  'var'
]);

let deduplicatedStacks = 0;

function normalizeFontValue(value) {
  if (!Array.isArray(value)) return value;

  const normalized = value.map(normalizeFontValue);
  const plainFontStack =
    normalized.length > 0 &&
    normalized.every((entry) => typeof entry === 'string') &&
    !expressionOperators.has(normalized[0]);

  if (!plainFontStack) return normalized;

  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) deduplicatedStacks += 1;
  return unique;
}

for (const layer of runtime.layers || []) {
  if (layer.layout?.['text-font']) {
    layer.layout['text-font'] = normalizeFontValue(layer.layout['text-font']);
  }
}

// MapLibre GL JS 5.11+ renders glyphs from local browser fonts when the
// style omits the root glyphs URL. This removes the external glyph service
// as a runtime dependency and prevents remote font-stack 404s.
delete runtime.glyphs;
runtime.metadata = {
  ...(runtime.metadata || {}),
  'occumed:glyph-rendering': 'local-maplibre'
};

report.endpoints = {
  ...(report.endpoints || {}),
  glyphs: null
};
report.localGlyphRendering = true;
report.deduplicatedFontStacks = deduplicatedStacks;

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Enabled MapLibre local glyph rendering and deduplicated ${deduplicatedStacks} font stack(s).`
);
