import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

function openFont(font) {
  if (typeof font !== 'string') return font;

  if (font.startsWith('DIN Pro')) {
    if (/Bold/i.test(font)) return /Italic/i.test(font) ? 'Open Sans Bold Italic' : 'Open Sans Bold';
    if (/Medium|Semibold/i.test(font)) {
      return /Italic/i.test(font) ? 'Open Sans Semibold Italic' : 'Open Sans Semibold';
    }
    if (/Italic/i.test(font)) return 'Open Sans Italic';
    return 'Open Sans Regular';
  }

  if (font.startsWith('Arial Unicode MS')) {
    if (/Bold/i.test(font)) return 'Noto Sans Bold';
    if (/Italic/i.test(font)) return 'Noto Sans Italic';
    return 'Noto Sans Regular';
  }

  return font;
}

function rewrite(value) {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
  }
  return openFont(value);
}

let changedLayers = 0;
for (const layer of runtime.layers || []) {
  const textFont = layer.layout?.['text-font'];
  if (!textFont) continue;

  const before = JSON.stringify(textFont);
  layer.layout['text-font'] = rewrite(textFont);
  if (JSON.stringify(layer.layout['text-font']) !== before) changedLayers += 1;
}

await fs.writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
console.log(`Normalized active font stacks in ${changedLayers} runtime layers.`);
