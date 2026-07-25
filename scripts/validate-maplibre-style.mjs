import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = path.join(root, 'public/style/occumed-open.json');
const runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));

const validationStyle = structuredClone(runtime);
validationStyle.sprite = String(validationStyle.sprite || '').replace(
  '__OCCUMED_PUBLIC_ORIGIN__',
  'https://map.invalid'
);

const findings = validateStyleMin(validationStyle);
const errors = findings.filter((finding) => finding.severity !== 'warning');
const warnings = findings.filter((finding) => finding.severity === 'warning');

if (warnings.length) {
  console.warn(`MapLibre style validation reported ${warnings.length} warning(s):`);
  for (const warning of warnings.slice(0, 25)) console.warn(`- ${warning.message}`);
}

if (errors.length) {
  console.error(`MapLibre style validation failed with ${errors.length} error(s):`);
  for (const error of errors.slice(0, 50)) console.error(`- ${error.message}`);
  process.exit(1);
}

console.log(`MapLibre style specification validation passed (${warnings.length} warning(s)).`);
