# Sul replacement candidate validation contract

The `occumed-replacement-sul.pmtiles` candidate remains inactive until the GitHub Actions candidate gate passes.

The gate locks the candidate by exact byte size and SHA-256, serves it through an isolated one-source validation server, and checks:

- exactly one browser vector source;
- source maxzoom 16 and no source switching;
- land and landcover at regional zoom;
- transportation and buildings in Porto Alegre and Curitiba;
- transportation coverage around Florianopolis;
- four views around the former rectangular child-grid crossing;
- deterministic zoom checkpoints from z0 through z16 and back;
- no external vector requests, page errors, or HTTP failures;
- no blank screenshots or long high-contrast horizontal/vertical seam signatures.

Passing this gate does not activate the archive. Neighbor ownership and final manifest activation remain separate explicit steps.
