#!/usr/bin/env bash
set -euo pipefail

output="${1:?Usage: build-world-surface.sh OUTPUT.pmtiles}"
tippecanoe_version="${TIPPECANOE_VERSION:-2.79.0}"
surface_workdir="$(mktemp -d /tmp/occumed-world-surface-XXXXXX)"
trap 'rm -rf "$surface_workdir"' EXIT

output_dir="$(dirname "$output")"
mkdir -p "$output_dir"
output_path="$(cd "$output_dir" && pwd)/$(basename "$output")"

git clone --depth 1 --branch "$tippecanoe_version" \
  https://github.com/felt/tippecanoe.git "$surface_workdir/tippecanoe"
make -C "$surface_workdir/tippecanoe" -j2

curl --fail --location --retry 5 \
  --output "$surface_workdir/ne_10m_land.geojson" \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson
curl --fail --location --retry 5 \
  --output "$surface_workdir/ne_10m_geography_regions_polys.geojson" \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_geography_regions_polys.geojson
curl --fail --location --retry 5 \
  --output "$surface_workdir/ne_10m_glaciated_areas.geojson" \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_glaciated_areas.geojson

mkdir -p "$surface_workdir/bathymetry"
for band in \
  A_10000 B_9000 C_8000 D_7000 E_6000 F_5000 \
  G_4000 H_3000 I_2000 J_1000 K_200 L_0; do
  curl --fail --location --retry 5 \
    --output "$surface_workdir/bathymetry/ne_10m_bathymetry_${band}.geojson" \
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_bathymetry_${band}.geojson"
done

node scripts/prepare-world-bathymetry.mjs \
  --input-dir "$surface_workdir/bathymetry" \
  --output "$surface_workdir/ne_10m_bathymetry.geojson"
node scripts/prepare-world-landcover.mjs \
  --land "$surface_workdir/ne_10m_land.geojson" \
  --geography "$surface_workdir/ne_10m_geography_regions_polys.geojson" \
  --glaciers "$surface_workdir/ne_10m_glaciated_areas.geojson" \
  --output "$surface_workdir/ne_10m_landcover.geojson"

"$surface_workdir/tippecanoe/tippecanoe" \
  --force \
  --minimum-zoom=0 \
  --maximum-zoom=10 \
  --preserve-input-order \
  --no-feature-limit \
  --no-tile-size-limit \
  --no-simplification-of-shared-nodes \
  -L "land:$surface_workdir/ne_10m_land.geojson" \
  -L "landcover:$surface_workdir/ne_10m_landcover.geojson" \
  -L "depth:$surface_workdir/ne_10m_bathymetry.geojson" \
  --output="$output_path"

test -s "$output_path"
test "$(head -c 7 "$output_path")" = "PMTiles"
echo "Built worldwide physical surface at $output_path."
