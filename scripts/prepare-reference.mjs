import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'style.json');
const publicDir = path.join(root, 'public');
const output = path.join(publicDir, 'style.json');

await fs.mkdir(publicDir, { recursive: true });
await fs.copyFile(source, output);

console.log('Copied the uploaded Occu-Med Terrain style.json byte-for-byte to public/style.json.');
