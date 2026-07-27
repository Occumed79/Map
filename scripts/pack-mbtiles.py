#!/usr/bin/env python3

import argparse
import gzip
import json
import pathlib
import sqlite3


def parse_args():
    parser = argparse.ArgumentParser(description="Pack a Z/X/Y PBF tree into MBTiles.")
    parser.add_argument("--tiles", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


args = parse_args()
tile_root = pathlib.Path(args.tiles)
metadata = json.loads(pathlib.Path(args.metadata).read_text(encoding="utf-8"))
output = pathlib.Path(args.output)
output.unlink(missing_ok=True)

connection = sqlite3.connect(output)
connection.executescript(
    """
    PRAGMA journal_mode=OFF;
    PRAGMA synchronous=OFF;
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (
      zoom_level INTEGER,
      tile_column INTEGER,
      tile_row INTEGER,
      tile_data BLOB
    );
    CREATE UNIQUE INDEX tile_index
      ON tiles (zoom_level, tile_column, tile_row);
    """
)

metadata_rows = []
for key, value in metadata.items():
    if key == "vector_layers":
        continue
    metadata_rows.append((key, str(value)))
metadata_rows.append(
    (
        "json",
        json.dumps({"vector_layers": metadata.get("vector_layers", [])}, separators=(",", ":")),
    )
)
connection.executemany("INSERT INTO metadata (name, value) VALUES (?, ?)", metadata_rows)

tiles = []
for tile_path in sorted(tile_root.glob("*/*/*.pbf")):
    zoom = int(tile_path.parts[-3])
    tile_x = int(tile_path.parts[-2])
    tile_y = int(tile_path.stem)
    tms_y = (1 << zoom) - 1 - tile_y
    payload = gzip.compress(tile_path.read_bytes(), compresslevel=6, mtime=0)
    tiles.append((zoom, tile_x, tms_y, payload))

connection.executemany(
    "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
    tiles,
)
connection.commit()
connection.close()
print(f"Packed {len(tiles)} vector tiles into {output}.")
