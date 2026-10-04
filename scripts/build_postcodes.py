#!/usr/bin/env python3
"""Map each Swedish postal code (postnummer) to the election districts that contain its addresses.

There is no open official list of postal code areas, so the source is the addr:postcode tag
in OpenStreetMap. Each node or way with that tag is one address. The script finds the district
that contains each address and counts the addresses per district.

The output data/postcodes.json maps "11122" to [["01800101", 412], ["01800102", 37]],
sorted by count, largest first. The browser loads it the first time a user types digits
into the search box.

Usage:
    python3 scripts/build_postcodes.py raw/sweden-latest.osm.pbf raw/valdistrikt-land.geojson

Download the OSM extract from https://download.geofabrik.de/europe/sweden-latest.osm.pbf.
The district file is the output of clip_to_land.py.
"""
import argparse
import collections
import json
import re
import sys
import time
from pathlib import Path

import numpy
import osmium
import osmium.filter
import pyproj
import shapely
import shapely.geometry

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "postcodes.json"

# Swedish postal codes have five digits and never start with 0.
POSTCODE = re.compile(r"^[1-9]\d{4}$")

# An address outside every district (on a pier, or on land that the coastline clip removed)
# goes to the nearest district if it is at most this many metres away.
MAX_DISTANCE = 500.0

# A district with less than this share of the addresses of a postal code is dropped.
# Most such entries are addresses with a wrong postal code in OSM, not real overlaps.
MIN_SHARE = 0.05


def read_addresses(pbf_path):
    """Read the addresses with a valid postal code from an OSM extract.

    Args:
        pbf_path: an .osm.pbf file.

    Returns:
        A tuple (postcodes, lons, lats). A way gives the mean of its node locations.
    """
    postcodes, lons, lats = [], [], []
    skipped = 0
    fp = (osmium.FileProcessor(pbf_path, osmium.osm.NODE | osmium.osm.WAY)
          .with_locations()
          .with_filter(osmium.filter.KeyFilter("addr:postcode")))
    for obj in fp:
        code = obj.tags["addr:postcode"].replace(" ", "")
        if not POSTCODE.match(code):
            skipped += 1
            continue
        if obj.is_node():
            if not obj.location.valid():
                continue
            lon, lat = obj.location.lon, obj.location.lat
        else:
            locs = [n.location for n in obj.nodes if n.location.valid()]
            if not locs:
                continue
            lon = sum(loc.lon for loc in locs) / len(locs)
            lat = sum(loc.lat for loc in locs) / len(locs)
        postcodes.append(code)
        lons.append(lon)
        lats.append(lat)
    print(f"read {len(postcodes)} addresses, skipped {skipped} with a malformed postal code",
          file=sys.stderr)
    return postcodes, lons, lats


def read_districts(geojson_path):
    """Return the district codes and shapely geometries from a GeoJSON file in SWEREF99 TM."""
    gj = json.loads(geojson_path.read_text(encoding="utf-8"))
    ids = [ft["properties"]["Valdistriktskod"] for ft in gj["features"]]
    geoms = [shapely.make_valid(shapely.geometry.shape(ft["geometry"])) for ft in gj["features"]]
    return ids, geoms


def assign(points, geoms):
    """Return, for each point, the index of the district that contains it, or -1.

    A point on a shared border goes to the first district that the tree returns.
    """
    tree = shapely.STRtree(geoms)
    result = numpy.full(len(points), -1)
    point_idx, geom_idx = tree.query(points, predicate="intersects")
    result[point_idx[::-1]] = geom_idx[::-1]
    missing = numpy.flatnonzero(result < 0)
    point_idx, geom_idx = tree.query_nearest(points[missing], max_distance=MAX_DISTANCE)
    result[missing[point_idx]] = geom_idx
    print(f"{len(missing) - len(point_idx)} addresses are outside every district",
          file=sys.stderr)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pbf", type=Path)
    ap.add_argument("districts", type=Path)
    args = ap.parse_args()

    t0 = time.time()
    postcodes, lons, lats = read_addresses(args.pbf)
    print(f"addresses read ({time.time() - t0:.0f}s)", file=sys.stderr)
    ids, geoms = read_districts(args.districts)
    print(f"{len(ids)} districts read ({time.time() - t0:.0f}s)", file=sys.stderr)

    to_sweref = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3006", always_xy=True)
    xs, ys = to_sweref.transform(numpy.asarray(lons), numpy.asarray(lats))
    district_idx = assign(shapely.points(xs, ys), geoms)

    counts = collections.defaultdict(collections.Counter)
    for code, idx in zip(postcodes, district_idx):
        if idx >= 0:
            counts[code][ids[idx]] += 1
    out = {}
    for code, c in sorted(counts.items()):
        total = c.total()
        out[code] = [(d, n) for d, n in c.most_common() if n >= MIN_SHARE * total]
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB, {len(out)} postal codes, "
          f"{time.time() - t0:.0f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
