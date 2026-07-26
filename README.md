# Occu-Med Map

A reusable Occu-Med basemap that uses the uploaded **Occu-Med Terrain** export as the cartographic blueprint while rendering through MapLibre and independent/open map services.

## Target

The supplied Mapbox Studio screenshots are the visual acceptance reference for:

- globe scale, black space, and the white-blue atmospheric rim;
- vivid oceans and visible bathymetry;
- pale land, forest, grassland, wetland, agriculture, desert, snow, and urban separation;
- terrain relief and contours;
- road, boundary, place-label, water-label, and POI hierarchy;
- globe, regional, city, and street zoom transitions.

The goal is a close visual replica without a Mapbox token or Mapbox-hosted runtime dependency. It is not represented as a pixel-identical copy of Mapbox proprietary data.

## Runtime

- MapLibre GL JS
- the worldwide Occu-Med Planetiler + PMTiles source when a regional archive is available
- a safe global open-vector fallback for low zoom and missing archives
- open terrain and relief services
- locally compiled sprites
- open glyphs
- generated runtime style at `/style/occumed-open.json`

No `VITE_MAPBOX_ACCESS_TOKEN`, `mapbox-gl`, `mapbox://` URL, or Mapbox API endpoint is required by the active build.

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

Create the map through the shared helper rather than constructing a raw MapLibre instance from the style URL. The helper registers the PMTiles protocol, resolves the deployed origin, installs worldwide archive routing, and preserves application-owned overlays.

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

map.on('occumedworldsourcechange', (event) => {
  console.debug('Occu-Med regional basemap source', event.region || 'global fallback');
});
```

Directly fetching the style and passing it to a separate `new maplibregl.Map(...)` instance is not supported for worldwide mode because that bypasses PMTiles protocol registration and regional source routing.

## Validation

The build verifies:

- the original export remains intact;
- the generated style passes the MapLibre style specification;
- no active source, sprite, or glyph URL points to Mapbox;
- globe, terrain, landcover, water, labels, and viewer-quality settings remain calibrated to the screenshot reference set;
- worldwide PMTiles planning, release publication, byte-range proxying, and regional source switching remain wired;
- no application-specific overlay data is included.
