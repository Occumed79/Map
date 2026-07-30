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
- one immutable worldwide foundation plus deterministic non-overlapping PMTiles owners
- locally compiled sprites
- browser-local glyph rendering
- generated runtime style at `/style/occumed-open.json`

No `VITE_MAPBOX_ACCESS_TOKEN`, `mapbox-gl`, `mapbox://` URL, Mapbox API endpoint, OpenFreeMap source, or external vector fallback is used by the active build.

## Worldwide tile architecture

MapLibre sees only `occumed-open`, whose URL is permanent from zoom 0 through 16. The browser does not load the world manifest, select an archive, register a PMTiles protocol, or replace a source while the map moves.

The existing worldwide and regional PMTiles archives are offline inputs only.
The offline builder assigns one authority per layer family, clips and normalizes
geometry, removes duplicates and contained overlaps, rejects malformed,
oversized, and tile-shaped surface polygons, and writes each final Z/X/Y once.

Production loads a versioned ownership manifest, performs one deterministic
owner lookup, and returns the selected archive's stored MVT bytes unchanged.
It does not connect to Neon, merge shards, synthesize landcover, create
geometry, or stretch parent/child tiles. The browser never sees the owner
inventory and never switches its single source.

See [the immutable tileset build guide](docs/offline-global-tileset.md) for
the complete offline build and mandatory visual validation workflow.

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

Required tileset location (unless deployed at `dist/immutable-world/manifest.json`):

```text
OCCUMED_IMMUTABLE_TILESET_MANIFEST=/absolute/path/to/immutable-world/manifest.json
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
- globe, landcover, water, labels, and viewer-quality settings remain calibrated to the screenshot reference set;
- only one permanent vector source and one same-origin Z/X/Y template exist in the style;
- browser-side PMTiles routing, `source.setUrl()`, fallback URLs, and OpenFreeMap are absent;
- the immutable manifest is complete, non-overlapping, and fail-closed;
- every split-prefix ancestor and descendant tile has one deterministic prebuilt owner;
- production contains no Neon tile cache, runtime merge, geometry creation, landcover synthesis, or parent/child stretch path;
- mandatory static and exact-camera motion captures reject seams, tile footprints, stretched polygons, inconsistent neighbors, blank frames, and source switching;
- no application-specific overlay data is included.
