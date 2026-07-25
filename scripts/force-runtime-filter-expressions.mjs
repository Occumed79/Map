import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const ambiguousRootOperators = new Set([
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'in',
  '!in',
  'all',
  'any',
  'none',
  'has',
  '!has'
]);

let forcedLayers = 0;
for (const layer of runtime.layers || []) {
  if (!Array.isArray(layer.filter)) continue;
  if (!ambiguousRootOperators.has(layer.filter[0])) continue;

  layer.filter = ['case', layer.filter, true, false];
  forcedLayers += 1;
}

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(`Forced expression-mode parsing for ${forcedLayers} runtime filters.`);
