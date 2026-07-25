import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spritezero from '@chrispahm/spritezero';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(root, 'public/sprites');

async function listSvgFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listSvgFiles(absolute)));
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) files.push(absolute);
  }

  return files;
}

function generateLayout(options) {
  return new Promise((resolve, reject) => {
    spritezero.generateLayout(options, (error, layout) => {
      if (error) reject(error);
      else resolve(layout);
    });
  });
}

function generateImage(layout) {
  return new Promise((resolve, reject) => {
    spritezero.generateImage(layout, (error, image) => {
      if (error) reject(error);
      else resolve(image);
    });
  });
}

async function writeSprite(images, pixelRatio, suffix) {
  const dataLayout = await generateLayout({ imgs: images, pixelRatio, format: true });
  const imageLayout = await generateLayout({ imgs: images, pixelRatio, format: false });
  const png = await generateImage(imageLayout);

  await fs.writeFile(
    path.join(outputDir, `occumed${suffix}.json`),
    `${JSON.stringify(dataLayout, null, 2)}\n`
  );
  await fs.writeFile(path.join(outputDir, `occumed${suffix}.png`), png);
}

const rootEntries = await fs.readdir(root, { withFileTypes: true });
const spriteDirectories = rootEntries
  .filter((entry) => entry.isDirectory() && /^Sprite-\d+$/i.test(entry.name))
  .map((entry) => path.join(root, entry.name))
  .sort();

if (!spriteDirectories.length) {
  throw new Error('No Sprite-* directories were found in the Mapbox export.');
}

const imageById = new Map();
for (const directory of spriteDirectories) {
  for (const file of await listSvgFiles(directory)) {
    const id = path.basename(file, path.extname(file));
    const svg = await fs.readFile(file);
    const existing = imageById.get(id);

    if (existing && !existing.equals(svg)) {
      throw new Error(`Conflicting SVG files use the same sprite id: ${id}`);
    }

    if (!existing) imageById.set(id, svg);
  }
}

const images = [...imageById.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, svg]) => ({ id, svg }));

if (images.length < 100) {
  throw new Error(`Expected a complete sprite export; found only ${images.length} unique SVGs.`);
}

await fs.mkdir(outputDir, { recursive: true });
await writeSprite(images, 1, '');
await writeSprite(images, 2, '@2x');

console.log(`Generated 1x and 2x Occu-Med sprites from ${images.length} unique SVG files.`);
