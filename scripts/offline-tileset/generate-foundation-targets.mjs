#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${key || '<end>'}.`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  if (!result.plan || !result.output) throw new Error('--plan and --output are required.');
  return result;
}

const options = parseArguments(process.argv.slice(2));
const plan = JSON.parse(await fs.readFile(path.resolve(options.plan), 'utf8'));
const maxZoom = Number(options['max-zoom'] || plan.routingZoom);
if (!Number.isSafeInteger(maxZoom) || maxZoom < 0 || maxZoom > plan.routingZoom) {
  throw new Error(`Foundation max zoom must be between 0 and ${plan.routingZoom}.`);
}

const foundation = [];
for (let z = 0; z <= maxZoom; z += 1) {
  const width = 2 ** z;
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) foundation.push({ z, x, y });
  }
}
const document = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  planVersion: plan.planVersion,
  selectedOwners: [],
  targets: { foundation },
  totalAddressedTiles: foundation.length
};
const output = path.resolve(options.output);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
console.log(`Generated ${foundation.length} foundation targets through z${maxZoom}.`);
