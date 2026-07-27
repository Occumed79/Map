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
6. consolidates shard tiles at zoom 0–5 into `occumed-world-overview.pmtiles`;
7. builds a generalized worldwide `land` surface;
8. publishes a server-only routing manifest after every required archive exists.

The browser never selects or reads these archives. It uses one permanent vector template:

```text
/tiles/{z}/{x}/{y}.pbf
```

The Node gateway uses the consolidated overview at zoom 0–5. At zoom 6–16 it looks up every regional archive intersecting the requested tile, reads the storage pieces, deduplicates stable feature IDs, merges each MVT layer, adds the worldwide land surface, and caches the completed tile. Shard boundaries and archive URLs are therefore invisible to MapLibre.

## Launch the virtual worldwide build

After the 754 regional archives are complete, run this workflow manually:

```text
Build Virtual Worldwide Tileset
```

The release tag defaults to:

```text
occumed-world-v1
```

It publishes `occumed-world-overview.pmtiles`, `occumed-world-surface.pmtiles`, and the version 2 server-only `world-virtual-manifest.json` to the release. The legacy `world-manifest.json` can remain during rollout because the new browser never requests either manifest.

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

To point the server at a compatible server-only manifest:

```bash
OCCUMED_WORLD_MANIFEST_URL=https://storage.example.org/world-virtual-manifest.json npm start
```

## Remaining enrichment stages

The worldwide vector schema and delivery path are independent from terrain enrichment. Generated contours, bathymetric bands, Overture enrichment, and complete route-relation shield metadata can be added to the virtual MVT response without changing the one permanent browser source.
