# Clean worldwide flat map v2

This production path replaces the PMTiles containment implementation with a clean MapLibre application using one complete worldwide vector source.

## Runtime contract

- Flat Mercator projection.
- Exactly one worldwide vector source.
- No PMTiles archive download or localization.
- No regional shard lookup.
- No Neon tile cache.
- No runtime tile merge, geometry synthesis, or parent/child transformation.
- No globe, atmosphere, terrain, hillshade, or 3D building path.

## Occu-Med cartography

- Water: `#79BCEC`.
- Parks and green space: `#A5CC8E`.
- Roads: `#F2F2F2`.
- Administrative boundaries: `#A65966`.
- Full-world initial view.

## Merge gate

The exact production build and start commands must render and save screenshots for:

1. whole world;
2. North America;
3. Europe and Africa;
4. Fresno street-level view.

The branch must not merge until those screenshots are manually inspected and show continuous map coverage without rectangular blanks or corrupted geometry.
