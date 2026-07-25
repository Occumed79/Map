import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedBlobs = {
  'style.json': '8c2dd7395d74c95ef19df7b668198a74124fb7e0',
  'license.txt': '704e4a07e0da5a6da8604d202343f015334e2acb'
};

function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

async function countSvgs(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) count += await countSvgs(absolute);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) count += 1;
  }

  return count;
}

for (const [file, expected] of Object.entries(expectedBlobs)) {
  const content = await fs.readFile(path.join(root, file));
  const actual = gitBlobSha(content);
  if (actual !== expected) {
    throw new Error(`${file} changed. Expected immutable Git blob ${expected}, received ${actual}.`);
  }
}

const style = JSON.parse(await fs.readFile(path.join(root, 'style.json'), 'utf8'));
if (style.name !== 'Occu-Med Terrain') throw new Error('Unexpected source style name.');
if (style.version !== 8) throw new Error('Unexpected source style version.');
if (!style.sources?.composite?.url?.startsWith('mapbox://')) {
  throw new Error('The original export no longer contains its reference composite source.');
}

const rootEntries = await fs.readdir(root, { withFileTypes: true });
const spriteDirs = rootEntries.filter(
  (entry) => entry.isDirectory() && /^Sprite-\d+$/i.test(entry.name)
);
let svgCount = 0;
for (const directory of spriteDirs) svgCount += await countSvgs(path.join(root, directory.name));

if (spriteDirs.length < 5) throw new Error(`Expected at least five Sprite-* directories; found ${spriteDirs.length}.`);
if (svgCount < 100) throw new Error(`Expected a complete SVG export; found only ${svgCount} files.`);

console.log(
  `Original Occu-Med Terrain export is intact: ${style.layers.length} layers and ${svgCount} uploaded SVG files.`
);
