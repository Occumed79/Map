import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylePath = path.resolve(root, 'public/style/style.json');
const styleText = await fs.readFile(stylePath, 'utf8');
const style = JSON.parse(styleText);

const failures = [];
const layers = style.layers || [];

if (style.version !== 8) failures.push('Style version must be 8.');
if (!style.sources?.occumed) failures.push('Missing occumed vector source.');
if (layers.length < 50) failures.push(`Expected a complete basemap, found only ${layers.length} layers.`);
if (!layers.some((layer) => layer.type === 'symbol')) failures.push('Missing label/symbol layers.');
if (!layers.some((layer) => layer['source-layer'] === 'buildings')) failures.push('Missing buildings layer coverage.');
if (!layers.some((layer) => layer['source-layer'] === 'roads')) failures.push('Missing roads layer coverage.');
if (!layers.some((layer) => layer['source-layer'] === 'places')) failures.push('Missing place-label coverage.');
if (styleText.includes('mapbox://')) failures.push('Generated style still contains a Mapbox URL.');
if (styleText.includes('mapbox.mapbox-')) failures.push('Generated style still references Mapbox tilesets.');

if (failures.length) {
  console.error('Style validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Style validation passed with ${layers.length} layers and no Mapbox endpoints.`);
