Repair only canonical worldwide PMTiles archives still absent after the 401-success pass.
Triggered: 2026-07-27T01:57:00Z
Mode: cancel the two unfinished jobs, preserve every published canonical PMTiles asset, and schedule every genuinely missing shard.
Verification: public range check plus authenticated GitHub release-asset fallback.
Shard timeout: 360 minutes.
Final gate: publish the worldwide manifest only when zero canonical shards remain missing.
