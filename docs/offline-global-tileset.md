# Immutable worldwide PMTiles build

The production map uses one browser source and an immutable PMTiles ownership
manifest. Existing worldwide and regional archives are build inputs only.
Production never decodes MVT geometry, merges shards, queries Neon, synthesizes
landcover, or substitutes parent/child tiles.

## Authority and ownership

| Output layers | Sole offline authority |
|---|---|
| `land`, `depth` | `occumed-world-surface.pmtiles` |
| `landcover` | `occumed-world-overview.pmtiles` |
| roads, buildings, boundaries, labels, other cartography | one regional owner |

The deterministic plan starts with z6 logical cells. A cell whose locked
candidate input set is too large is split through z7 or z8. Leaf prefixes never
overlap. When a prefix is split, its own ancestor tile is assigned explicitly
to the first descendant owner in stable child order. Consequently every
addressed z0–z16 tile resolves to exactly one foundation, exact-tile, or prefix
owner.

Missing entries are immutable empty results from that owner; production never
tries a second archive.

## Full offline build

The complete published input inventory is about 270 GB. Use a build host with
enough space for the locked input cache, work files, and final owners. All
outputs are created at staging paths, verified as PMTiles, fsynced, copied to a
pending file, verified again, and atomically promoted.

Create the SHA-locked owner plan and worldwide foundation target list:

```bash
npm run tiles:plan-world -- \
  --output config/immutable-owner-plan.json

npm run tiles:targets-foundation -- \
  --plan config/immutable-owner-plan.json \
  --output build/offline-global/foundation-targets.json
```

Localize the two worldwide inputs and build the z0–z6 foundation:

```bash
npm run tiles:localize -- \
  --plan config/immutable-owner-plan.json \
  --targets build/offline-global/foundation-targets.json \
  --output-dir immutable-inputs \
  --report build/offline-global/foundation-inputs.json

npm run tiles:build-foundation -- \
  --plan config/immutable-owner-plan.json \
  --targets build/offline-global/foundation-targets.json \
  --input-report build/offline-global/foundation-inputs.json \
  --output-dir build/offline-global/artifact
```

For every `owners[].id` in the plan, localize its locked candidates, enumerate
the exact addresses in their PMTiles directories, and build that owner. The
input directory is a shared digest-verified cache, so repeated candidates are
reused.

```bash
OWNER_ID=z6-10-24

npm run tiles:localize -- \
  --plan config/immutable-owner-plan.json \
  --owner-id "$OWNER_ID" \
  --output-dir immutable-inputs \
  --report "build/offline-global/$OWNER_ID-inputs.json"

npm run tiles:targets-owner -- \
  --plan config/immutable-owner-plan.json \
  --owner-id "$OWNER_ID" \
  --input-report "build/offline-global/$OWNER_ID-inputs.json" \
  --output "build/offline-global/$OWNER_ID-targets.json"

npm run tiles:build-owner -- \
  --plan config/immutable-owner-plan.json \
  --owner-id "$OWNER_ID" \
  --targets "build/offline-global/$OWNER_ID-targets.json" \
  --input-report "build/offline-global/$OWNER_ID-inputs.json" \
  --output-dir build/offline-global/artifact
```

Finalize only after every planned owner report exists:

```bash
npm run tiles:finalize -- \
  --plan config/immutable-owner-plan.json \
  --foundation build/offline-global/artifact/reports/foundation.json \
  --owner-dir build/offline-global/artifact/reports/owners \
  --output build/offline-global/artifact/manifest.json
```

The finalizer marks an incomplete inventory as `validationFixture: true`.
Production rejects it. `OCCUMED_ALLOW_PARTIAL_TILESET_FIXTURE=true` exists only
for the bounded local visual fixture and must not be set in deployment.

## Production

Set `OCCUMED_IMMUTABLE_TILESET_MANIFEST` to the local manifest path or an HTTPS
manifest URL. Local assets are resolved beneath the manifest directory. Remote
assets use the manifest's optional `assetBaseUrl`.

The server validates completeness, artifact identity, SHA metadata, safe asset
paths, non-overlapping prefixes, and unique exact-tile assignments before
serving tiles. Each request performs a bounded index lookup and a single
PMTiles byte-range read. Stored gzip MVT bytes are returned unchanged.

## Mandatory validation

Run the structural and production checks:

```bash
npm run build
```

Run the browser gate against the finalized manifest and validation target
document:

```bash
PLAYWRIGHT_BROWSERS_PATH=build/offline-global/playwright \
npm run check:immutable-visuals -- \
  --manifest build/offline-global/artifact/manifest.json \
  --targets build/offline-global/representative-targets.json \
  --output-dir visual-validation/immutable-final
```

The target document must cover global, North America, South America, Europe,
Pacific, antimeridian, regional, city, and street views, plus 30 exact-camera
motion checkpoints. Validation fails for rectangular footprints, vertical or
horizontal seams, stretched polygons, inconsistent neighbors, blank frames,
source switching, page errors, or tile delivery failures. Saved screenshots
must also be inspected at full size before an artifact is accepted.
