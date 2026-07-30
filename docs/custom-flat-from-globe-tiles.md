# Custom flat map from the existing globe PMTiles

This branch reuses the existing worldwide surface, overview, and regional PMTiles as offline inputs. The immutable owner pipeline from PR #45 is replayed on current main and the browser projection is locked to flat Mercator.

Production contract:

- one browser vector source at `/tiles/{z}/{x}/{y}.pbf`;
- exact prebuilt z0-z16 addressing;
- no runtime shard merge, geometry synthesis, Neon cache, or regional source switching;
- `land` and `depth` from the worldwide surface;
- `landcover` from the worldwide overview at foundation zooms and one deterministic regional owner above the handoff;
- roads, buildings, boundaries, labels, and other detail from one deterministic regional owner;
- no globe, atmosphere, fog, terrain, hillshade, or external basemap.
