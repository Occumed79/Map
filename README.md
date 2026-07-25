# Occu-Med Map

This repository is built around the original Mapbox Studio export for **Occu-Med Terrain**.

## Source of truth

The root files below are treated as immutable export artifacts:

- `style.json` — the complete 6,649-line Mapbox Style Specification document.
- `license.txt` — the license supplied with the export.
- `Sprite-*/*.svg` — the exported SVG symbol library.

The application does not recreate the palette, layer ordering, filters, label hierarchy, road widths, or zoom behavior. The exact `style.json` is copied byte-for-byte into the Vite public output during development and production builds.

## Exact visual-reference stage

The first implementation stage intentionally renders the untouched export with Mapbox GL JS and the original Mapbox data, glyph, and sprite declarations. This creates the visual baseline against which every independent replacement must be compared.

```bash
npm install
cp .env.example .env
# Add VITE_MAPBOX_ACCESS_TOKEN to .env
npm run dev
```

The token is required only for the exact reference renderer because the exported style still points to the original Mapbox-hosted Streets, Terrain, Bathymetry, sprite, and glyph endpoints.

## Integrity protection

`npm run validate:export` verifies the Git blob hashes of `style.json` and `license.txt`, checks the original source declarations, and confirms required terrain, water, building, and land layers remain present. A build fails if the export is edited accidentally.

## Migration sequence

1. Establish and visually approve the exact reference renderer.
2. Generate and self-host a sprite atlas from the uploaded SVG files without altering the style rules.
3. Self-host compatible glyphs while preserving label layout and hierarchy.
4. Build an open-data compatibility source that satisfies the original layer and property expectations.
5. Compare the independent candidate against the exact reference at controlled zoom levels and locations.
6. Connect Atlas, Insight Hub, and other applications only after the parity checks pass.

The exact reference stage does **not** claim to remove Mapbox usage. It exists to prevent the independent conversion from drifting away from the approved design.
