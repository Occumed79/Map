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
- OpenFreeMap/OpenMapTiles vector data
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

```js
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const response = await fetch('https://map-yxjb.onrender.com/style/occumed-open.json');
const style = await response.json();

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [-98.5, 28],
  zoom: 2.05,
  renderWorldCopies: false
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
- no application-specific overlay data is included.
