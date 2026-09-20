#!/usr/bin/env python3
"""Clip the valdistrikt polygons from Valmyndigheten to a land mask.

The official polygons extend far out to sea. After the clip, the map shows the coastline.

Usage:
    python3 scripts/clip_to_land.py raw/valdistrikt-riket-2026.geojson raw/gadm41_SWE_0.json \\
        raw/valdistrikt-land.geojson

The land mask is a (Multi)Polygon GeoJSON in WGS84. GADM 4.1 level 0 works well:
https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_SWE_0.json
A district that does not intersect the land mask keeps its original geometry.
"""
import json
import sys
import time

import pyproj
import shapely.geometry
import shapely.ops
import shapely.strtree
import shapely.validation

POLYGON_TYPES = (shapely.geometry.Polygon, shapely.geometry.MultiPolygon)


def polygonal(geom):
    """Return the polygon parts of geom as one geometry, or None when there are none."""
    parts = [g for g in getattr(geom, "geoms", [geom]) if isinstance(g, POLYGON_TYPES)]
    return shapely.ops.unary_union(parts) if parts else None


def load_land(mask_path):
    """Return the land mask as a list of valid polygons in SWEREF99 TM."""
    with open(mask_path, encoding="utf-8") as f:
        mask = json.load(f)
    to_sweref = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True).transform
    land = []
    for ft in mask["features"]:
        g = shapely.ops.transform(to_sweref, shapely.geometry.shape(ft["geometry"]))
        land.extend(g.geoms if hasattr(g, "geoms") else [g])
    land = [shapely.validation.make_valid(p) if not p.is_valid else p for p in land]
    # The 50 m buffer keeps districts that touch the coast intact when the mask is a bit off.
    return [p.buffer(50) for p in land]


def main(src, mask_path, out):
    t0 = time.time()
    land = load_land(mask_path)
    tree = shapely.strtree.STRtree(land)
    print(f"land mask: {len(land)} polygons ({time.time() - t0:.0f}s)", file=sys.stderr)

    with open(src, encoding="utf-8") as f:
        gj = json.load(f)
    kept, clipped, unchanged = 0, 0, 0
    for ft in gj["features"]:
        geom = shapely.geometry.shape(ft["geometry"])
        if not geom.is_valid:
            geom = polygonal(shapely.validation.make_valid(geom))
        idx = tree.query(geom, predicate="intersects")
        if len(idx) == 0:
            unchanged += 1
            continue
        cand = shapely.ops.unary_union([land[i] for i in idx]) if len(idx) > 1 else land[idx[0]]
        if cand.contains(geom):
            kept += 1
            continue
        res = polygonal(geom.intersection(cand))
        if res is None or res.is_empty or res.area < 1000:
            unchanged += 1
            continue
        if not isinstance(res, shapely.geometry.MultiPolygon):
            res = shapely.geometry.MultiPolygon([res])
        ft["geometry"] = shapely.geometry.mapping(res)
        clipped += 1
    print(f"inland {kept}, clipped {clipped}, unchanged {unchanged} ({time.time() - t0:.0f}s)",
          file=sys.stderr)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(gj, f)


if __name__ == "__main__":
    main(*sys.argv[1:4])
