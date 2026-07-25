import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layers } from '@protomaps/basemaps';
import { OCCUMED_FLAVOR } from '../src/occumed-flavor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.resolve(root, 'public/style/style.json');

const style = {
  version: 8,
  name: 'Occu-Med Terrain',
  center: [-98.5, 39.5],
  zoom: 3.3,
  projection: { name: 'globe' },
  glyphs: '__GLYPHS_URL__',
  sprite: '__SPRITE_URL__',
  sources: {
    occumed: {
      type: 'vector',
      url: 'pmtiles://__PMTILES_URL__',
      attribution:
        '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }
  },
  layers: layers('occumed', OCCUMED_FLAVOR, { lang: 'en' })
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(style, null, 2)}\n`);

console.log(`Generated ${style.layers.length} Occu-Med basemap layers.`);
