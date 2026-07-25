# Occu-Med Map

A reusable Occu-Med basemap package built from the uploaded **Occu-Med Terrain** Mapbox Studio export.

This repository owns only the shared visual foundation: terrain, land, water, roads, buildings, boundaries, labels, fonts, and sprites. It does **not** contain provider, employer, procurement, opportunity, clinic, or other application data.

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
3. Replacing Mapbox-hosted tiles, glyphs, sprites, and terrain with open endpoints.
4. Compiling every uploaded SVG into locally hosted 1x and 2x MapLibre sprite sheets.
5. Replacing unavailable DIN/Arial glyph stacks with crisp open font stacks.
6. Producing `public/style/compatibility-report.json` that documents every mapped or unsupported layer.

The goal is a clear, crisp **visual clone**, not a copy of Mapbox's proprietary hosted data. OpenStreetMap/OpenMapTiles features can differ from Mapbox features even when the cartography is matched.

## Runtime services and cost boundary

The default build uses:

- **MapLibre GL JS** for rendering. No Mapbox GL JS package or Mapbox access token.
- **OpenFreeMap** for OpenMapTiles vector data and open glyphs. Its public instance currently requires no key and states that map views and requests are not metered. It is an as-is public service without an SLA.
- **AWS Terrain Tiles public dataset** for global Terrarium elevation tiles and hillshading. No subscription is required for the public dataset.
- **Locally generated sprites** served by this repository.

There are no Mapbox map-load charges in this implementation. The open endpoints remain configurable so the same style can later move to independently hosted infrastructure without redesigning the map.

## Development

```bash
npm install
npm run dev
```

The asset preparation step compiles the sprites and generates the open runtime style before Vite starts.

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

The Node server adds CORS headers and serves a resolved shared style at:

```text
/style/occumed-open.json
```

## Using the basemap in another application

Applications can use the hosted style directly:

```js
import * as maplibregl from 'maplibre-gl';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://YOUR-MAP-SERVICE/style/occumed-open.json',
  center: [-98.5, 39.5],
  zoom: 3.3
});

map.on('load', () => {
  // Add only this application's private sources and layers here.
});
```

Or use the reusable helper in [`src/occumed-map.js`](./src/occumed-map.js).

## Integrity and quality gates

`npm run build` fails when:

- the original `style.json` or `license.txt` changes;
- the uploaded SVG export is incomplete;
- a `mapbox://` or Mapbox API endpoint remains in the runtime style;
- required road, building, water, boundary, place, POI, or label layers disappear;
- original layer ordering is changed;
- local sprite generation is incomplete;
- unavailable Mapbox font stacks remain;
- application-specific data sources are added to the shared style.

No existing Occu-Med application should be pointed to this map until the generated preview has been visually reviewed at world, regional, city, and street zoom levels.
