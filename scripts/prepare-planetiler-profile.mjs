#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(process.argv[2] || path.join(root, 'planetiler/occumed-basemap.yml'));
const outputPath = path.resolve(
  process.argv[3] || path.join(root, '.planetiler-data/generated/occumed-basemap.yml')
);

let profile = await fs.readFile(sourcePath, 'utf8');

const replacements = [
  ['version: "0.2.0"', 'version: "0.3.0"'],
  [
    'default: \'${ args.area + ".osm.pbf" }\'',
    'default: \'${ args.area.replace("/", "_") + ".osm.pbf" }\''
  ],
  [
    'leisure: [park, garden, playground, golf_course, pitch, nature_reserve]',
    'leisure: [garden, playground, golf_course, pitch]'
  ],
  [
    '        attributes: &transport_name_attributes\n' +
      '          - key: class\n' +
      '            tag_value: highway\n',
    '        attributes: &transport_name_attributes\n' +
      '          - key: class\n' +
      '            value:\n' +
      '              - if:\n' +
      '                  highway: [unclassified, residential, living_street]\n' +
      '                value: minor\n' +
      '              - else:\n' +
      '                  tag_value: highway\n'
  ],
  ...['region', 'town', 'village'].map((place) => [
    `          place: ${place}\n` +
      '        attributes:\n' +
      '          - key: class\n' +
      '            tag_value: place\n' +
      '          - key: name\n' +
      '            tag_value: name\n' +
      '          - key: population\n',
    `          place: ${place}\n` +
      '        attributes:\n' +
      '          - key: class\n' +
      '            tag_value: place\n' +
      '          - key: name\n' +
      '            tag_value: name\n' +
      '          - key: name:latin\n' +
      '            value:\n' +
      '              coalesce:\n' +
      '                - tag_value: name:en\n' +
      '                - tag_value: name\n' +
      '          - key: population\n'
  ]),
  [
    '          place: [suburb, neighbourhood, hamlet]\n' +
      '        attributes:\n' +
      '          - key: class\n' +
      '            tag_value: place\n' +
      '          - key: name\n' +
      '            tag_value: name\n' +
      '          - key: rank\n',
    '          place: [suburb, neighbourhood, hamlet]\n' +
      '        attributes:\n' +
      '          - key: class\n' +
      '            tag_value: place\n' +
      '          - key: name\n' +
      '            tag_value: name\n' +
      '          - key: name:latin\n' +
      '            value:\n' +
      '              coalesce:\n' +
      '                - tag_value: name:en\n' +
      '                - tag_value: name\n' +
      '          - key: rank\n'
  ],
  [
    '          - key: name\n' +
      '            tag_value: name\n\n' +
      '  - id: mountain_peak\n',
    '          - key: name\n' +
      '            tag_value: name\n' +
      '      - source: osm\n' +
      '        geometry: line\n' +
      '        min_zoom: 6\n' +
      '        include_when:\n' +
      '          __all__:\n' +
      '            waterway: [river, canal, stream]\n' +
      '            name: __any__\n' +
      '        attributes:\n' +
      '          - key: class\n' +
      '            tag_value: waterway\n' +
      '          - key: name\n' +
      '            tag_value: name\n\n' +
      '  - id: mountain_peak\n'
  ]
];

for (const [before, after] of replacements) {
  if (profile.includes(after)) continue;
  const occurrences = profile.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Expected one source-profile match but found ${occurrences}: ${before.slice(0, 100)}`
    );
  }
  profile = profile.replace(before, after);
}

const requiredMarkers = [
  'version: "0.3.0"',
  'args.area.replace("/", "_")',
  'leisure: [garden, playground, golf_course, pitch]',
  '- id: aerodrome_label',
  'highway: [unclassified, residential, living_street]',
  'waterway: [river, canal, stream]'
];
for (const marker of requiredMarkers) {
  if (!profile.includes(marker)) throw new Error(`Generated Planetiler profile is missing: ${marker}`);
}
if ((profile.match(/          - key: name:latin/g) || []).length < 7) {
  throw new Error('Generated Planetiler profile does not provide name:latin across the place hierarchy.');
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, profile);
console.log(`Prepared corrected Planetiler profile at ${outputPath}.`);
