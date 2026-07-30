#!/usr/bin/env bash
set -euo pipefail

geometry="${1:?Usage: build-regional-land-owner.sh REGION.geojson OUTPUT.pmtiles}"
output="${2:?Usage: build-regional-land-owner.sh REGION.geojson OUTPUT.pmtiles}"
workdir="$(mktemp -d /tmp/occumed-owner-land-XXXXXX)"
trap 'rm -rf "$workdir"' EXIT

curl --fail --location --retry 5 --retry-all-errors \
  --output "$workdir/ne_10m_land.geojson" \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson

ogr2ogr -f GeoJSON \
  "$workdir/land-clipped.geojson" \
  "$workdir/ne_10m_land.geojson" \
  -clipsrc "$geometry" \
  -nln land

test -s "$workdir/land-clipped.geojson"
mkdir -p "$(dirname "$output")"

tippecanoe \
  --force \
  --minimum-zoom=11 \
  --maximum-zoom=16 \
  --preserve-input-order \
  --no-feature-limit \
  --no-tile-size-limit \
  --no-simplification-of-shared-nodes \
  --detect-shared-borders \
  -L "land:$workdir/land-clipped.geojson" \
  --output="$output"

test -s "$output"
test "$(head -c 7 "$output")" = PMTiles
echo "Built exact-region authoritative land owner surface: $output"
