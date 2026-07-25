# Occu-Med Map

A shared, reusable Occu-Med basemap package for Atlas, Insight Hub, Network Map, and future applications.

## What this repository provides

- MapLibre GL JS rendering.
- PMTiles support for an independently hosted vector archive.
- A complete Protomaps-compatible basemap layer system.
- A custom Occu-Med Terrain flavor preserving the licensed Outdoors-derived palette.
- Roads, bridges, tunnels, buildings, water, parks, boundaries, transit, POIs, and labels.
- One generated style endpoint that every Occu-Med application can reuse.
- No Mapbox access token or Mapbox runtime endpoint.

## Runtime architecture

```text
Occu-Med applications
        ↓
/style/style.json
        ↓
MapLibre GL JS
        ↓
VITE_PMTILES_URL
        ↓
independently hosted .pmtiles archive
```

The style is generated from `src/occumed-flavor.js` using the complete open basemap layer definitions supplied by `@protomaps/basemaps`.

## Local development

```bash
npm install
npm run dev
```

The viewer reads the archive URL from `VITE_PMTILES_URL`. When no value is supplied, it looks for `/data/occumed.pmtiles`.

## Build and validation

```bash
npm run check
```

This generates the complete style, verifies that core roads/buildings/places/symbol layers exist, rejects Mapbox URLs, and builds the Vite application.

## Shared endpoints

```text
VITE_STYLE_URL=/style/style.json
VITE_PMTILES_URL=/data/occumed.pmtiles
VITE_GLYPHS_URL=https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf
VITE_SPRITE_URL=https://protomaps.github.io/basemaps-assets/sprites/v4/light
```

The glyph and sprite endpoints are configurable so they can be moved into this repository during the asset-mirroring stage without changing application code.

## Current status

The complete open layer system and Occu-Med color flavor are now generated during development and production builds. The remaining infrastructure step is to place the production PMTiles archive and mirrored font/sprite assets on shared storage, then point each Occu-Med app to these common endpoints.
