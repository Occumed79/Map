# Vector data

The production vector archive is intentionally not committed to Git because a worldwide PMTiles file is much larger than normal source code.

For local testing, place the archive here as:

```text
public/data/occumed.pmtiles
```

For production, host the archive on storage that supports HTTP byte-range requests and set `VITE_PMTILES_URL` to its public URL.
