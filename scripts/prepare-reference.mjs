import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'style.json');
const outputDir = path.join(root, 'public');
const output = path.join(outputDir, 'style.json');

await fs.mkdir(outputDir, { recursive: true });
await fs.copyFile(source, output);

console.log('Copied the immutable Mapbox export to public/style.json without modification.');
