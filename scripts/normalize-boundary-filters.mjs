import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const comparisonOperators = new Set(['==', '!=', '>', '>=', '<', '<=']);
const adminLevelMap = new Map([
  [0, 2],
  [1, 4],
  [2, 6]
]);

function isGet(value, key) {
  return Array.isArray(value) && value[0] === 'get' && value[1] === key;
}

function booleanNumber(value) {
  if (value === 'true') return 1;
  if (value === 'false') return 0;
  return value;
}

function rewrite(node, boundaryLayer) {
  if (!Array.isArray(node) || typeof node[0] !== 'string') return node;

  const [operator, ...args] = node;
  const rewrittenArgs = args.map((child) => rewrite(child, boundaryLayer));

  if (!boundaryLayer || !comparisonOperators.has(operator) || rewrittenArgs.length < 2) {
    return [operator, ...rewrittenArgs];
  }

  let [left, right, ...rest] = rewrittenArgs;

  if (isGet(left, 'admin_level') && typeof right === 'number') {
    right = adminLevelMap.get(right) ?? right;
  }

  if (isGet(left, 'maritime')) {
    right = booleanNumber(right);
  }

  // The first converter used a constant 0 for Mapbox's text `disputed`
  // field because the schemas differ. Restore the OpenMapTiles field here.
  if (left === 0 && (right === 'true' || right === 'false')) {
    left = ['get', 'disputed'];
    right = booleanNumber(right);
  }

  if (isGet(left, 'disputed')) {
    right = booleanNumber(right);
  }

  return [operator, left, right, ...rest];
}

let changedLayers = 0;
for (const layer of runtime.layers || []) {
  if (!layer.filter) continue;

  const originalSourceLayer = layer.metadata?.['occumed:original-source-layer'];
  const boundaryLayer = originalSourceLayer === 'admin' || layer['source-layer'] === 'boundary';
  if (!boundaryLayer) continue;

  const before = JSON.stringify(layer.filter);
  layer.filter = rewrite(layer.filter, true);
  if (JSON.stringify(layer.filter) !== before) changedLayers += 1;
}

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(`Translated Mapbox boundary filters in ${changedLayers} runtime layers.`);
