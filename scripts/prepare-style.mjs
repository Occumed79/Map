import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = path.resolve(root, process.argv[2] || 'source-style/style.json');
const outputPath = path.resolve(root, process.argv[3] || 'public/style/style.json');
const reportPath = path.resolve(root, 'public/style/conversion-report.json');
const mappingPath = path.resolve(root, 'config/source-layer-map.json');

const [sourceText, mappingText] = await Promise.all([
  fs.readFile(inputPath, 'utf8'),
  fs.readFile(mappingPath, 'utf8')
]);

const original = JSON.parse(sourceText);
const sourceLayerMap = JSON.parse(mappingText);
const dropped = [];
const mapped = [];

function openFont(fonts = []) {
  const joined = fonts.join(' ').toLowerCase();

  if (joined.includes('italic')) return ['Noto Sans Italic'];
  if (joined.includes('bold')) return ['Noto Sans Bold'];
  if (joined.includes('medium')) return ['Noto Sans Medium'];
  return ['Noto Sans Regular'];
}

function removeMapboxMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !key.startsWith('mapbox:'))
  );
}

const layers = [];

for (const layer of original.layers || []) {
  const next = structuredClone(layer);
  next.metadata = removeMapboxMetadata(next.metadata);

  if (next.metadata && Object.keys(next.metadata).length === 0) {
    delete next.metadata;
  }

  if (next.source === 'composite') {
    next.source = 'occumed';
  }

  if (next['source-layer']) {
    const oldName = next['source-layer'];
    const newName = sourceLayerMap[oldName];

    if (!newName) {
      dropped.push({ id: next.id, sourceLayer: oldName });
      continue;
    }

    next['source-layer'] = newName;
    mapped.push({ id: next.id, from: oldName, to: newName });
  }

  if (next.layout?.['text-font']) {
    next.layout['text-font'] = openFont(next.layout['text-font']);
  }

  layers.push(next);
}

const converted = {
  ...original,
  name: 'Occu-Med Terrain Open',
  metadata: removeMapboxMetadata(original.metadata),
  sources: {
    occumed: {
      type: 'vector',
      url: 'pmtiles://__PMTILES_URL__',
      attribution: '© OpenStreetMap contributors'
    }
  },
  sprite: '/sprites/sprite',
  glyphs: '/fonts/{fontstack}/{range}.pbf',
  layers
};

delete converted.fog;

if (converted.metadata && Object.keys(converted.metadata).length === 0) {
  delete converted.metadata;
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(converted, null, 2)}\n`);
await fs.writeFile(
  reportPath,
  `${JSON.stringify({
    input: path.relative(root, inputPath),
    output: path.relative(root, outputPath),
    originalLayerCount: original.layers?.length || 0,
    convertedLayerCount: layers.length,
    mapped,
    dropped,
    note: 'Layer names are mapped automatically. Filters and data properties still require visual QA against the selected open tileset.'
  }, null, 2)}\n`
);

console.log(`Prepared ${layers.length} layers in ${path.relative(root, outputPath)}.`);
console.log(`Dropped ${dropped.length} layers without an open-data equivalent.`);
