#!/usr/bin/env bash
set -euo pipefail

AREA="${OCCUMED_TILE_AREA:-california}"
OUTPUT="${OCCUMED_PMTILES_OUTPUT:-$PWD/public/tiles/occumed.pmtiles}"
MEMORY="${OCCUMED_PLANETILER_MEMORY:-4g}"
IMAGE="${OCCUMED_PLANETILER_IMAGE:-ghcr.io/onthegomap/planetiler:latest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${OCCUMED_PLANETILER_DATA_DIR:-$ROOT/.planetiler-data}"

mkdir -p "$DATA_DIR" "$(dirname "$OUTPUT")"

OUTPUT_DIR="$(cd "$(dirname "$OUTPUT")" && pwd)"
OUTPUT_NAME="$(basename "$OUTPUT")"

echo "Building Occu-Med PMTiles"
echo "  area:   $AREA"
echo "  output: $OUTPUT"
echo "  memory: $MEMORY"

docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx${MEMORY}" \
  -v "$ROOT/planetiler:/profile:ro" \
  -v "$DATA_DIR:/data" \
  -v "$OUTPUT_DIR:/output" \
  "$IMAGE" \
  /profile/occumed-basemap.yml \
  --download \
  --area="$AREA" \
  --output="/output/$OUTPUT_NAME" \
  --force

echo "Created $OUTPUT"
echo "Build the app with:"
echo "  OCCUMED_PMTILES_URL=__OCCUMED_PUBLIC_ORIGIN__/tiles/$OUTPUT_NAME npm run build"
