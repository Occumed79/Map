# Occu-Med Map

A reusable Occu-Med basemap package built from the uploaded **Occu-Med Terrain** Mapbox Studio export.

This repository owns only the shared visual foundation: globe atmosphere, terrain, land, water, roads, buildings, boundaries, labels, fonts, and sprites. It does **not** contain provider, employer, procurement, opportunity, clinic, applicant, or other application data.

## Architecture

```text
Occu-Med Map repository
  ├─ shared basemap style and assets
  └─ reusable MapLibre initialization helper

Atlas
  ├─ loads the shared basemap
  └─ adds Atlas provider/service overlays only

Insight Hub
  ├─ loads the shared basemap
  └─ adds Insight Hub intelligence overlays only

Network Map
  ├─ loads the shared basemap
  └─ adds Network Map clinic/search overlays only
```

Each application creates its own independent map instance and owns its own sources, markers, filters, popups, and state. Data from one application cannot appear in another merely because they use this basemap.

## Visual source of truth

The root [`style.json`](./style.json) and all `Sprite-*` directories are the untouched Mapbox export. They are never rewritten in place.

The build creates `public/style/occumed-open.json` by:

1. Preserving the original layer order, paint colors, line widths, opacities, zoom thresholds, label rules, and filters wherever the open schema supports them.
2. Translating Mapbox Streets source-layer and property names to the OpenMapTiles schema.
3. Normalizing OpenMapTiles landuse, park, wetland, settlement, and road values into the categories expected by the exported style.
4. Translating the exported Mapbox globe atmosphere into MapLibre's supported sky model.
5. Replacing Mapbox-hosted tiles, glyphs, sprites, and terrain with open endpoints.
6. Compiling every uploaded SVG into locally hosted 1x and 2x MapLibre sprite sheets.
7. Replacing unavailable DIN/Arial glyph stacks with open font stacks.
8. Producing `public/style/compatibility-report.json` that documents mapped and unsupported source layers.

The goal is a clear, crisp **visual clone**, not a copy of Mapbox's proprietary hosted data. OpenStreetMap/OpenMapTiles feature coverage can differ from Mapbox even when the cartography is matched.

## Runtime services and cost boundary

The default build uses:

- **MapLibre GL JS** for rendering. No Mapbox GL JS package or Mapbox access token.
- **OpenFreeMap** for OpenMapTiles vector data and open glyphs.
- **AWS Terrain Tiles public dataset** for global Terrarium elevation tiles and hillshading.
- **Locally generated sprites** served by this repository.

There are no Mapbox map-load charges in this implementation. Every external endpoint is configurable so the same style can later move to independently hosted infrastructure without redesigning the map.

## Development

```bash
npm install
npm run dev
```

The asset preparation step compiles sprites and generates the open runtime style before Vite starts.

## Production build

```bash
npm install
npm run build
npm start
```

Set `PUBLIC_ORIGIN` on the deployed Map service, for example:

```text
PUBLIC_ORIGIN=https://map.example.com
```

The Node server adds CORS headers and serves the resolved shared style at:

```text
/style/occumed-open.json
```

## Using the basemap in another application

Applications can load the hosted style directly:

```js
import * as maplibregl from 'maplibre-gl';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://YOUR-MAP-SERVICE/style/occumed-open.json',
  center: [-98.5, 24],
  zoom: 2.43,
  projection: 'globe'
});

map.on('load', () => {
  // Add only this application's private sources and layers here.
});
```

Or use the reusable helper:

```js
import { createOccumedMap } from './src/occumed-map.js';

const map = await createOccumedMap({
  container: 'map',
  styleUrl: 'https://YOUR-MAP-SERVICE/style/occumed-open.json',
  controls: true,
  scaleControl: false
});

map.on('load', () => {
  map.addSource('my-app-data', {
    type: 'geojson',
    data: myApplicationGeoJson
  });

  // This source exists only inside this map instance.
});
```

All constructor camera options can be overridden per application without modifying the shared style.

## Integrity and quality gates

`npm run build` fails when:

- the original `style.json` or `license.txt` changes;
- the uploaded SVG export is incomplete;
- a `mapbox://` or Mapbox API endpoint remains in the runtime style;
- required road, building, water, boundary, place, POI, or label layers disappear;
- original layer ordering changes;
- local sprite generation is incomplete;
- unavailable Mapbox font stacks remain;
- the globe loses its dark space, atmosphere, horizon, or anchored hillshade;
- OpenMapTiles landuse and settlement values bypass compatibility normalization;
- road or label hierarchy falls below the required layer count;
- application-specific data sources or layers enter the shared basemap.

The standalone viewer is intentionally only a visual-QA shell. Production applications load the same basemap and then add their own isolated overlays.
