# Occu-Med Map

A reusable Occu-Med basemap package that renders the uploaded **Occu-Med Terrain** Mapbox Studio export directly.

## What is hosted here

GitHub and Render host:

- the application;
- the untouched root `style.json`;
- the reusable map initialization helper;
- the full-screen viewer.

The build copies `style.json` byte-for-byte to `/style.json`. It does not translate layers, replace colors, change fonts, rewrite filters, alter the atmosphere, or substitute open map data.

The original file still references Mapbox Streets, Terrain, Bathymetry, glyph, and sprite services. Mapbox GL JS therefore requires `VITE_MAPBOX_ACCESS_TOKEN` at runtime.

## Data isolation

This repository contains only the basemap. It contains no provider, clinic, employer, procurement, opportunity, applicant, or other application data.

Each application creates its own independent map instance and adds only its own overlays:

```text
Hosted Occu-Med style
        +
Insight Hub overlays only
```

```text
Hosted Occu-Med style
        +
Atlas overlays only
```

Sharing the same basemap does not share markers, filters, popups, application state, or databases.

## Development

```bash
npm install
cp .env.example .env
# Add VITE_MAPBOX_ACCESS_TOKEN
npm run dev
```

## Production

```bash
npm install
npm run build
npm start
```

Render environment variable:

```text
VITE_MAPBOX_ACCESS_TOKEN=<your public Mapbox token>
```

The standalone viewer is served at `/` and the exact uploaded style is served with CORS at:

```text
/style.json
```

## Reuse in another application

```js
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;

const response = await fetch('https://YOUR-MAP-SERVICE.onrender.com/style.json');
const style = await response.json();

const map = new mapboxgl.Map({
  container: 'map',
  style,
  center: [-98.5, 24],
  zoom: 2.43,
  antialias: true
});

map.on('load', () => {
  // Add only this application's sources and layers here.
});
```

## Integrity protection

`npm run validate:export` verifies that the uploaded `style.json`, `license.txt`, and SVG export remain intact. CI also runs `cmp style.json public/style.json`, so the build fails unless the deployed style is an exact byte-for-byte copy.
