# Occu-Med Map

A shared, reusable Occu-Med basemap package for Atlas, Insight Hub, Network Map, and future applications.

## Repository goals

- Preserve the Occu-Med Terrain visual style.
- Render with MapLibre GL JS.
- Load an independently hosted PMTiles vector archive.
- Keep the style, sprites, glyph configuration, and app integration in one place.
- Avoid requiring a Mapbox access token at runtime.

## Planned repository layout

```text
public/
  style/
    style.json
  sprites/
  fonts/
  data/
scripts/
config/
src/
```

## Local development

```bash
npm install
npm run dev
```

The viewer reads the PMTiles URL from `VITE_PMTILES_URL`. When no value is supplied, it looks for `/data/occumed.pmtiles`.

## Status

The MapLibre and PMTiles foundation is being built first. The exported Occu-Med Terrain style will then be adapted to the open vector-tile schema while retaining its visual rules.
