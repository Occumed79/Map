# Occu-Med Map

A reusable Occu-Med basemap that uses the uploaded **Occu-Med Terrain** export as the cartographic blueprint while rendering through MapLibre and independent/open map services.

## Target

The supplied Mapbox Studio screenshots are the visual acceptance reference for:

- globe scale, black space, and the white-blue atmospheric rim;
- clear blue oceans;
- saturated green land with forest, grassland, wetland, agriculture, desert, snow, and urban separation;
- terrain relief and contours;
- road, boundary, place-label, water-label, and POI hierarchy;
- globe, regional, city, and street zoom transitions.

The goal is a close visual replica without a Mapbox token or Mapbox-hosted runtime dependency. It is not represented as a pixel-identical copy of Mapbox proprietary data.

## Runtime

- MapLibre GL JS
- one permanent MapLibre vector source at `/tiles/{z}/{x}/{y}.pbf`
- a server-side virtual worldwide tileset backed by the 754 PMTiles storage archives
- one consolidated zoom 0–5 overview and one generalized worldwide physical surface
- open elevation data used only for hillshade, not as a second basemap
- locally compiled sprites
- browser-local glyph rendering
- generated runtime style at `/style/occumed-open.json`

No `VITE_MAPBOX_ACCESS_TOKEN`, `mapbox-gl`, `mapbox://` URL, Mapbox API endpoint, OpenFreeMap source, or external vector fallback is used by the active build.

## Worldwide tile architecture

MapLibre sees only `occumed-open`, whose URL is permanent from zoom 0 through 16. The browser does not load the world manifest, select an archive, register a PMTiles protocol, or replace a source while the map moves.

The Node tile gateway resolves each Z/X/Y request on the server:

- zoom 0–5 comes from a consolidated overview built from the same regional schema;
- zoom 6–16 is resolved against every storage shard intersecting the requested tile;
- boundary tiles are decoded, deduplicated by stable feature ID, and re-encoded as one MVT;
- the worldwide `land` layer is merged into the same response at every zoom;
- nested Natural Earth bathymetry bands are served as the `depth` layer at globe
  and regional zooms, then fade before detailed navigation zooms;
- completed virtual tiles are held in a bounded in-memory cache and exposed with CDN cache headers.

The PMTiles archives and routing manifest are storage implementation details. Their URLs never appear in the MapLibre style.

## Source of truth

The root `style.json` remains unchanged and supplies the layer order, paint/layout rules, filters, and zoom logic. Build scripts translate only the incompatible hosted resources and source schema, then apply the screenshot-calibrated visual pass.

## Data isolation

This repository contains only the basemap. Atlas, Insight Hub, Network Map, and other applications each create their own map instance and add only their own sources, markers, filters, popups, and state.

## Development

```bash
npm install
npm run dev
```

## Production

```bash
npm install
npm run build
npm start
```

Optional Render variable:

```text
PUBLIC_ORIGIN=https://map-yxjb.onrender.com
```

## Reuse

Install the repository in the consuming application:

```bash
npm install github:Occumed79/Map
```

Create the map through the shared helper to retain the approved high-DPI, no-fade rendering defaults while preserving application-owned overlays.

```js
import { createOccumedMap } from '@occumed/map/src/occumed-map.js';

const map = await createOccumedMap({
  container: 'map',
  styleUrl: 'https://map-yxjb.onrender.com/style/occumed-open.json',
  center: [-98.5, 28],
  zoom: 2.05
});

map.on('load', () => {
  // Add only this application's overlays here.
});
```

## Validation

The build verifies:

- the original export remains intact;
- the generated style passes the MapLibre style specification;
- no active source, sprite, or glyph URL points to Mapbox;
- globe, terrain, landcover, water, labels, and viewer-quality settings remain calibrated to the screenshot reference set;
- only one permanent vector source and one same-origin Z/X/Y template exist in the style;
- browser-side PMTiles routing, `source.setUrl()`, fallback URLs, and OpenFreeMap are absent;
- the routing index includes every intersecting shard, including antimeridian segments;
- duplicate features are removed while boundary geometry is preserved;
- the overview, physical surface, regional merge, in-memory cache, and virtual release workflow remain wired;
- no application-specific overlay data is included.
