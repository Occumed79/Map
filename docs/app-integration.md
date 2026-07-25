# App integration

The shared map can be consumed by any Occu-Med app with MapLibre GL JS and the PMTiles protocol.

```js
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://YOUR-MAP-HOST/style/style.json',
  center: [-98.5, 39.5],
  zoom: 3.3
});
```

The published style must reference the same hosted PMTiles archive used by the standalone viewer. Application-specific markers, provider layers, employer overlays, and analytics should remain inside each app rather than being baked into this basemap repository.
