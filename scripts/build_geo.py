#!/usr/bin/env python3
"""Convert the valdistrikt GeoJSON from Valmyndigheten into data/districts.topojson.

The input is about 70 MB in SWEREF99 TM. The output is a small quantized TopoJSON in WGS84
with shared borders. WGS84 lets the browser use d3.geoMercator and put OpenStreetMap tiles
under the districts.

Usage:
    python3 scripts/build_geo.py raw/valdistrikt-land.geojson [--tolerance 25]

Download the source from val.se ("Valdistrikt - Hela Sverige", a zip with a GeoJSON inside)
and unzip it into raw/ first. Run clip_to_land.py on it before this script.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import pyproj
import shapely.geometry
import shapely.geometry.polygon
import shapely.ops
import shapely.validation
import topojson

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "districts.topojson"

# Source property name -> output property name.
KEEP = {
    "Valdistriktskod": "id",
    "Valdistriktsnamn": "name",
    "Kommunkod": "kommun",
    "Kommun": "kommunName",
    "Riksdagsvalkretskod": "valkrets",
    "Länskod": "lan",
}


def polygonal(geom):
    """Return the polygon parts of geom as one geometry. Lines and points are dropped."""
    polygon_types = (shapely.geometry.Polygon, shapely.geometry.MultiPolygon)
    parts = [g for g in getattr(geom, "geoms", [geom]) if isinstance(g, polygon_types)]
    return shapely.ops.unary_union(parts)


def to_feature(ft, to_wgs84):
    """Return the GeoJSON feature ft as a clean WGS84 MultiPolygon feature."""
    props = {v: ft["properties"][k] for k, v in KEEP.items()}
    geom = shapely.geometry.shape(ft["geometry"])
    if not geom.is_valid:
        # make_valid can return a GeometryCollection with stray lines and points.
        geom = polygonal(shapely.validation.make_valid(geom))
    if isinstance(geom, shapely.geometry.Polygon):
        geom = shapely.geometry.MultiPolygon([geom])
    geom = shapely.ops.transform(to_wgs84, geom)
    # d3-geo wants clockwise exterior rings. It treats a counter-clockwise ring as the complement
    # of the polygon on the sphere. shapely gives counter-clockwise rings.
    geom = shapely.geometry.MultiPolygon(
        [shapely.geometry.polygon.orient(p, sign=-1.0) for p in geom.geoms])
    return {"type": "Feature", "id": props["id"], "properties": props,
            "geometry": shapely.geometry.mapping(geom)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("geojson", type=Path)
    ap.add_argument("--tolerance", type=float, default=25.0,
                    help="simplification tolerance in metres (default 25)")
    ap.add_argument("--quantize", type=float, default=1e6,
                    help="quantization grid (1e6 is about 1.5 m over Sweden)")
    args = ap.parse_args()
    to_wgs84 = pyproj.Transformer.from_crs("EPSG:3006", "EPSG:4326", always_xy=True).transform

    t0 = time.time()
    gj = json.loads(args.geojson.read_text(encoding="utf-8"))
    print(f"loaded {len(gj['features'])} features ({time.time() - t0:.0f}s)", file=sys.stderr)

    feats = [to_feature(ft, to_wgs84) for ft in gj["features"]]
    topo = topojson.Topology(
        {"type": "FeatureCollection", "features": feats},
        prequantize=args.quantize,
        topology=True,
        # The tolerance is given in metres. The topology is in degrees.
        toposimplify=args.tolerance / 111_320,
        simplify_with="shapely",
        simplify_algorithm="dp",
        prevent_oversimplify=True,
        object_name="districts",
    )
    print(f"topology built ({time.time() - t0:.0f}s)", file=sys.stderr)

    out = json.loads(topo.to_json())
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB, "
          f"{len(out['arcs'])} arcs, {time.time() - t0:.0f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
