# Occu-Med custom Planetiler + PMTiles basemap

This directory defines the first Occu-Med-owned vector tile schema. It replaces dependence on a generic hosted OpenMapTiles endpoint with a reproducible Planetiler build that emits a PMTiles archive for MapLibre.

## What it does

`occumed-basemap.yml` emits the source-layer names the current runtime style expects:

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

The attributes are intentionally normalized around the runtime style: `class`, `subclass`, `brunnel`, `ramp`, `ref`, `rank`, `admin_level`, `disputed`, `render_height`, and related fields.

## Build a regional archive

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

An existing `.osm.pbf` can be used by invoking Planetiler directly and replacing `--download --area=...` with `--osm-path=/data/input.osm.pbf`.

## Activate the archive in the runtime style

Build the app with the archive URL:

```bash
OCCUMED_PMTILES_URL=__OCCUMED_PUBLIC_ORIGIN__/tiles/occumed.pmtiles npm run build
```

The style generator converts that value to:

```text
pmtiles://https://<deployed-origin>/tiles/occumed.pmtiles
```

The browser registers the PMTiles protocol before MapLibre creates the map. When `OCCUMED_PMTILES_URL` is not set, the existing open vector endpoint remains active so a missing archive cannot break the deployed map.

## Hosting outside the web service

A large archive should be uploaded to object storage that supports HTTP range requests and CORS. Then use an absolute URL:

```bash
OCCUMED_PMTILES_URL=https://tiles.example.org/occumed.pmtiles npm run build
```

Do not prepend `pmtiles://`; the build script handles it.

## Current scope

This initial profile owns the core vector schema and removes the largest source-schema mismatch. Terrain DEM, generated contours, GEBCO bathymetric bands, Overture enrichment, route-relation shield metadata, and full-world low-zoom Natural Earth generalization remain separate data-build stages and should not be faked inside the style layer.
