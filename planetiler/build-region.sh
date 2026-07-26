#!/usr/bin/env bash
set -euo pipefail

AREA="${OCCUMED_TILE_AREA:-california}"
BOUNDS="${OCCUMED_TILE_BOUNDS:-}"
OUTPUT="${OCCUMED_PMTILES_OUTPUT:-$PWD/public/tiles/occumed.pmtiles}"
MEMORY="${OCCUMED_PLANETILER_MEMORY:-6g}"
IMAGE="${OCCUMED_PLANETILER_IMAGE:-ghcr.io/onthegomap/planetiler:latest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${OCCUMED_PLANETILER_DATA_DIR:-$ROOT/.planetiler-data}"

mkdir -p "$DATA_DIR" "$(dirname "$OUTPUT")"

OUTPUT_DIR="$(cd "$(dirname "$OUTPUT")" && pwd)"
OUTPUT_NAME="$(basename "$OUTPUT")"

COMMON_ARGS=(
  generate-custom
  --schema=/profile/occumed-basemap.yml
  --download
  --area="$AREA"
  --output="/output/$OUTPUT_NAME"
  --tmpdir=/data/tmp
  --force
)

if [[ -n "$BOUNDS" ]]; then
  COMMON_ARGS+=(--bounds="$BOUNDS")
fi

echo "Building Occu-Med PMTiles"
echo "  area:   $AREA"
echo "  bounds: ${BOUNDS:-full extract}"
echo "  output: $OUTPUT"
echo "  memory: $MEMORY"

# Verify embedded schema examples before spending time downloading and processing data.
docker run --rm \
  -v "$ROOT/planetiler:/profile:ro" \
  "$IMAGE" \
  verify /profile/occumed-basemap.yml

docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx${MEMORY}" \
  -v "$ROOT/planetiler:/profile:ro" \
  -v "$DATA_DIR:/data" \
  -v "$OUTPUT_DIR:/output" \
  "$IMAGE" \
  "${COMMON_ARGS[@]}"

test -s "$OUTPUT"
sha256sum "$OUTPUT" | tee "$OUTPUT.sha256"
ls -lh "$OUTPUT" "$OUTPUT.sha256"

echo "Created $OUTPUT"
echo "Build the app with:"
echo "  OCCUMED_PMTILES_URL=__OCCUMED_PUBLIC_ORIGIN__/tiles/$OUTPUT_NAME npm run build"
