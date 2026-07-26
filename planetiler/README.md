# Occu-Med custom Planetiler + PMTiles basemap

This directory defines the Occu-Med-owned vector tile schema used by the reusable MapLibre basemap. It replaces dependence on a generic hosted OpenMapTiles endpoint with reproducible Planetiler archives whose source layers and attributes match the runtime style.

## Schema

`occumed-basemap.yml` emits the layers the runtime expects:

- `landcover`
- `landuse`
- `park`
- `water`
- `waterway`
- `transportation`
- `transportation_name`
- `building`
- `aeroway`
- `boundary`
- `place`
- `poi`
- `water_name`
- `mountain_peak`
- `housenumber`

Attributes are normalized around the exported style, including `class`, `subclass`, `brunnel`, `ramp`, `ref`, `rank`, `admin_level`, `disputed`, and `render_height`.

## Worldwide architecture

The global build uses Geofabrik's current world index to select leaf-region extracts. Each extract is independently built into a PMTiles archive with the same Occu-Med schema.

The workflow:

1. creates a worldwide, non-overlapping leaf-region plan;
2. divides the plan into six bounded GitHub Actions matrices;
3. builds every shard on free GitHub-hosted runners;
4. publishes archives, checksums, and metadata to the `occumed-world-v1` GitHub Release;
5. validates byte-range delivery for every archive;
6. publishes `occumed-world-manifest.json` only from successfully uploaded assets;
7. fails until the manifest reports zero missing regions.

The browser keeps the existing global overview at low zoom. Beginning at zoom 6, `src/world-pmtiles-router.js` selects the smallest matching regional archive and changes the shared vector source without replacing application overlays.

The deployed Node server exposes:

```text
/world-manifest.json
/world-tiles/occumed-<region>.pmtiles
```

Those endpoints proxy the GitHub Release assets, preserve HTTP range requests, and add the required CORS and cache headers. No paid object-storage account is required.

## Launch the worldwide build

The workflow can be started manually from GitHub Actions or by changing:

```text
planetiler/world-build.trigger
```

The release tag defaults to:

```text
occumed-world-v1
```

The runtime automatically checks:

```text
__OCCUMED_PUBLIC_ORIGIN__/world-manifest.json
```

Until the release manifest exists, the map safely retains the current global vector source.

## Build one regional archive locally

Docker is required.

```bash
OCCUMED_TILE_AREA=california npm run tiles:build
```

The default output is:

```text
public/tiles/occumed.pmtiles
```

Other Geofabrik areas can be selected without changing the profile:

```bash
OCCUMED_TILE_AREA=us/wisconsin npm run tiles:build
OCCUMED_TILE_AREA=australia/new-south-wales npm run tiles:build
```

An existing `.osm.pbf` can be used by setting `OCCUMED_OSM_PBF` to a file inside `OCCUMED_PLANETILER_DATA_DIR`.

## Single-archive override

Worldwide routing is enabled by default. To disable it and use one archive instead:

```bash
OCCUMED_WORLD_MANIFEST_URL=off \
OCCUMED_PMTILES_URL=__OCCUMED_PUBLIC_ORIGIN__/tiles/occumed.pmtiles \
npm run build
```

To use a different worldwide manifest:

```bash
OCCUMED_WORLD_MANIFEST_URL=https://tiles.example.org/occumed-world-manifest.json npm run build
```

## Remaining enrichment stages

The worldwide vector schema and delivery path are independent from terrain enrichment. Generated contours, GEBCO bathymetric bands, Overture enrichment, and complete route-relation shield metadata can be added as separate stages without changing the PMTiles routing architecture.
