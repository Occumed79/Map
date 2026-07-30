#!/usr/bin/env bash
set -euo pipefail

AREA="${OCCUMED_TILE_AREA:-california}"
OSM_PBF="${OCCUMED_OSM_PBF:-}"
OUTPUT="${OCCUMED_PMTILES_OUTPUT:-$PWD/public/tiles/occumed.pmtiles}"
MEMORY="${OCCUMED_PLANETILER_MEMORY:-6g}"
IMAGE="${OCCUMED_PLANETILER_IMAGE:-ghcr.io/onthegomap/planetiler:0.10.2}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${OCCUMED_PLANETILER_DATA_DIR:-$ROOT/.planetiler-data}"
PROFILE_DIR="$DATA_DIR/generated-profile"
PROFILE_PATH="$PROFILE_DIR/occumed-basemap.yml"

mkdir -p "$DATA_DIR/tmp" "$PROFILE_DIR" "$(dirname "$OUTPUT")"
node "$ROOT/scripts/prepare-planetiler-profile.mjs" \
  "$ROOT/planetiler/occumed-basemap.yml" \
  "$PROFILE_PATH"

OUTPUT_DIR="$(cd "$(dirname "$OUTPUT")" && pwd)"
OUTPUT_NAME="$(basename "$OUTPUT")"

# Planetiler custom YAML profiles are passed as the first positional argument.
# The build itself parses and validates the generated profile before processing OSM data.
COMMON_ARGS=(
  /profile/occumed-basemap.yml
  --area="$AREA"
  --output="/output/$OUTPUT_NAME"
  --tmpdir=/data/tmp
  --force
)

if [[ -n "$OSM_PBF" ]]; then
  if [[ ! -s "$OSM_PBF" ]]; then
    echo "OSM extract does not exist or is empty: $OSM_PBF" >&2
    exit 1
  fi
  case "$OSM_PBF" in
    "$DATA_DIR"/*)
      CONTAINER_OSM_PATH="/data/${OSM_PBF#"$DATA_DIR"/}"
      ;;
    *)
      echo "OCCUMED_OSM_PBF must be inside OCCUMED_PLANETILER_DATA_DIR so Docker can read it." >&2
      exit 1
      ;;
  esac
  COMMON_ARGS+=(--osm-path="$CONTAINER_OSM_PATH")
else
  COMMON_ARGS+=(--download)
fi

echo "Building Occu-Med PMTiles"
echo "  area:   $AREA"
echo "  source: ${OSM_PBF:-Geofabrik download}"
echo "  output: $OUTPUT"
echo "  memory: $MEMORY"
echo "  image:  $IMAGE"
echo "  schema: $PROFILE_PATH"

docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx${MEMORY}" \
  -v "$PROFILE_DIR:/profile:ro" \
  -v "$DATA_DIR:/data" \
  -v "$OUTPUT_DIR:/output" \
  "$IMAGE" \
  "${COMMON_ARGS[@]}"

# Planetiler runs as root inside the container and may leave root-owned temporary
# databases behind. Remove the temporary directory through the same container
# image so host-side cleanup cannot fail after a successful archive build.
docker run --rm \
  --entrypoint /bin/sh \
  -v "$DATA_DIR:/data" \
  "$IMAGE" \
  -c 'rm -rf /data/tmp'

test -s "$OUTPUT"
(
  cd "$OUTPUT_DIR"
  sha256sum "$OUTPUT_NAME" > "$OUTPUT_NAME.sha256"
)
ls -lh "$OUTPUT" "$OUTPUT.sha256"

echo "Created $OUTPUT"
echo "Build the app with:"
echo "  OCCUMED_PMTILES_URL=__OCCUMED_PUBLIC_ORIGIN__/tiles/$OUTPUT_NAME npm run build"
