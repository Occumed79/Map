# Offline Global Tileset Recovery Handoff

Status captured after Codex usage credits were exhausted on 2026-07-28/29.

## Critical state

- Target branch: `rebuild/offline-global-tileset`
- Remote branch was still identical to `main` at `ba835de833b7c62d26f7767a0cf06ed8dec287ee` when this handoff was written.
- The implementation described below had not yet been committed or pushed by Codex.
- The Codex workspace is therefore the only known location of the uncommitted source changes and generated artifacts.
- Do not delete or reset that Codex workspace before exporting/committing its changes.

## Intended architecture

- One browser vector source.
- Immutable worldwide PMTiles output.
- Deterministic non-overlapping owner partitions when a single physical file is too large.
- Every `z/x/y` tile belongs to exactly one owner.
- No Neon tile cache in the active production path.
- No runtime shard merging.
- No runtime landcover synthesis.
- No runtime parent/child stretching or overscaling.
- No production geometry creation.
- Offline-only clipping, schema normalization, deduplication, ancestor materialization, and malformed-feature rejection.

## Input inventory discovered

- 754 regional PMTiles archives plus worldwide overview and surface archives.
- Published regional input total reported by Codex: approximately 258.0 GB.
- Inputs were resolved from the existing GitHub Release and SHA-256 locked.
- Local `dist/virtual-assets` PMTiles files were only 325-byte fixtures and were correctly rejected as production inputs.

## Representative artifact results

Codex completed a representative validation build covering 17,901 exact `z/x/y` tiles plus three deterministic owner partitions for Fresno and both sides of the antimeridian.

### Foundation

- Final stable size: `250,938,363` bytes.
- Reported SHA-256 prefix: `b76dfa...`.
- Independent PMTiles verification passed after staged write, fsync, pending-file verification, and atomic rename.

### Representative manifest

- Total size across foundation and three non-overlapping owners: `272,198,460` bytes.
- A later manifest/artifact version after Fresno landcover correction was reported as `729e166...`.

## Builder defects already found and corrected locally

1. Node `Buffer` was returned where the PMTiles reader required an exact-range `ArrayBuffer`.
2. Polygon bounds used `Math.min(...points)` / `Math.max(...points)` and exceeded the JavaScript argument limit on detailed polygons; replaced with bounded linear scans.
3. Same-property polygon containment/deduplication was quadratic on dense tiles; replaced with deterministic spatial bucket indexing.
4. Legitimate buffered overview polygons exceeded the strict tile box; offline normalization was changed to clip to the exact tile boundary and revalidate encoded output.
5. The inherited runtime overscale helper validated intermediate MVT too early; ancestor materialization was moved into the offline builder and changed to feature-granular transform, clip, reject, then encode.
6. PMTiles owner metadata inherited an invalid center zoom; metadata was changed to derive center and zoom bounds from the owner’s actual addressed tiles.
7. Initial foundation output changed after the success report; writer was hardened to staging-path generation, verification, fsync, pending-copy verification, descriptor close, and atomic promotion.
8. Fresno z16 tiles lacked landcover because the overview z6 parent had no Fresno landcover. Authority was corrected so overview owns landcover at z0-6 and exactly one deterministic regional archive owns landcover above z6 for each partition.
9. Legacy AWS terrain/hillshade remained as a second browser source and caused readiness/network failures; Codex removed that source and dependent hillshade layer from the generated runtime style to enforce one browser source.

## Validation state reached before credit exhaustion

### Static views

Codex reported all nine static views passing after the Fresno landcover rebuild:

- Global
- North America
- South America
- Europe
- Pacific
- Antimeridian
- Fresno regional
- Fresno city
- Fresno street

Reported results:

- Required land rendered.
- Regional landcover rendered at Fresno street level.
- Transportation rendered.
- Exactly one style source.
- Zero network failures.
- Zero page errors.
- Zero detected seams.
- Zero rectangular tile footprints.
- Zero stretching detections.
- Zero blank-frame detections.
- Zero source changes.
- Zero neighboring-tile inconsistency detections.

### Motion validation

Motion validation was not finished.

The last reported change corrected only the first motion setup predicate: global starting views should require immutable-source readiness at the target camera, not visible landcover, because the global contract is land plus ocean depth. Motion frames were still intended to undergo every pixel/source gate.

## Immediate recovery instruction for the next Codex turn

Do not rebuild first. Preserve the workspace immediately:

1. Confirm the workspace still contains the uncommitted changes and generated reports.
2. Confirm the current branch is `rebuild/offline-global-tileset`.
3. Review `git status --short` and `git diff --stat`.
4. Exclude `node_modules`, downloaded PMTiles inputs, browser binaries, temporary build directories, and generated PMTiles artifacts from Git.
5. Commit all source, configuration, workflow, manifest, validator, report, and tracked screenshot changes.
6. Push the branch.
7. Open a draft PR.
8. Report the commit SHA and PR number before resuming any build or validation.

## Work still required after preservation

- Finish all continuous motion validations.
- Inspect saved screenshots manually, not only numeric gates.
- Prove complete deterministic worldwide ownership for every intended tile.
- Execute the production-scale immutable partition build, not only the 17,901-tile representative artifact.
- Keep every final PMTiles release asset below GitHub’s per-asset limit.
- Upload only final immutable partitions and the versioned ownership manifest.
- Keep the PR draft until the actual worldwide artifact set exists and is visually verified.
