# Exported source style

Place the untouched Mapbox Studio export at:

```text
source-style/style.json
```

Then run:

```bash
npm run prepare-style
```

The script writes the adapted style to `public/style/style.json` and creates `public/style/conversion-report.json` so every mapped or omitted layer can be reviewed.

The original export should remain unchanged in this folder. All generated edits belong in `public/style/`.
