#!/usr/bin/env python3
"""Download the Riksdag result per valdistrikt from resultat.val.se and write data/results.json.

The raw JSON is cached in raw/, so a second run is fast.

Usage:

    python3 scripts/fetch_results.py                          # riksdag (RD), final count (S)
    python3 scripts/fetch_results.py --valtyp RD --count P    # preliminary count
"""
import argparse
import concurrent.futures
import functools
import json
import os
import subprocess
import sys
import threading
import time

BASE = "https://resultat.val.se/data"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
OUT = os.path.join(ROOT, "data", "results.json")
UA = "election-map/1.0 (personal project; curl)"

# resultat.val.se sits behind Akamai. Akamai answers 429 to bursts and blocks the urllib
# fingerprint of Python. This is why the download goes through curl, with one global pace
# and a long pause after each 429.
RATE = 4.0  # requests per second across all workers
_pace_lock = threading.Lock()
_next_slot = [0.0]
_hold_until = [0.0]


def _pace():
    with _pace_lock:
        now = time.time()
        t = max(now, _next_slot[0], _hold_until[0])
        _next_slot[0] = t + 1.0 / RATE
    if t > now:
        time.sleep(t - now)


def _hold(seconds):
    with _pace_lock:
        _hold_until[0] = max(_hold_until[0], time.time() + seconds)


def get(url, cache_path, retries=8):
    """Return the JSON at url, from the cache when possible.

    Args:
        url: The URL to download.
        cache_path: Where the raw body is stored. An existing file is used as is.
        retries: The number of attempts before the function gives up.

    Raises:
        RuntimeError: All attempts failed.
    """
    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            return json.load(f)
    for attempt in range(retries):
        _pace()
        proc = subprocess.run(
            ["curl", "-sS", "-m", "30", "-A", UA, "-w", "\n%{http_code}", url],
            capture_output=True)
        body, _, code = proc.stdout.rpartition(b"\n")
        if proc.returncode == 0 and code == b"200":
            try:
                data = json.loads(body)
            except json.JSONDecodeError as e:
                print(f"  bad json from {url}: {e}", file=sys.stderr)
                time.sleep(2.0 * (attempt + 1))
                continue
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            with open(cache_path, "wb") as f:
                f.write(body)
            return data
        if code == b"429":
            wait = min(120, 10 * 2 ** attempt)
            print(f"  429 on {url.rsplit('/', 1)[1]}, pausing {wait}s", file=sys.stderr)
            _hold(wait)
            continue
        print(f"  retry {attempt + 1} {url}: http {code.decode()} "
              f"{proc.stderr.decode().strip()}", file=sys.stderr)
        time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"gave up on {url}")


def walk(node, path, out):
    """Collect (path, node) for every node below node in the valgeografi tree."""
    for child in node.get("valgeografi") or []:
        p = path + [child["kod"]]
        out.append((p, child))
        walk(child, p, out)


def parties_of(res):
    """Return (partikod, forkortning, namn, farg, antal) rows from a result blob."""
    rows = []
    for p in res["rosterPaverkaMandat"]["partiroster"]:
        # Rows without partikod are summary lines ("Övriga anmälda partier", visa=2/6).
        # They duplicate the itemised small parties, so they are skipped.
        if not p["partikod"]:
            continue
        rows.append((p["partikod"], p["partiforkortning"] or p["partibeteckning"],
                     p["partibeteckning"], p["fargkod"], p["antalRoster"]))
    ovr = res["rosterPaverkaMandat"]["rosterOvrigaPartier"]
    if ovr and ovr["antalRoster"]:
        rows.append(("OVR", "ÖVR", ovr["partibeteckning"], "#BCBCBC", ovr["antalRoster"]))
    return rows


def to_int(s):
    """Parse '21\xa0115' as 21115. Empty or None gives None (uppsamlingsdistrikt have no electorate)."""
    if isinstance(s, (int, float)):
        return int(s)
    s = (s or "").replace("\xa0", "").replace(" ", "")
    return int(s) if s else None


def to_float(s):
    """Parse '84,64\xa0%' as 84.64. Empty or None gives None."""
    if isinstance(s, (int, float)):
        return float(s)
    s = (s or "").replace("\xa0", "").replace(" ", "").replace("%", "").replace(",", ".")
    return float(s) if s else None


def fetch_result(path, valtillfalle, count):
    """Download the result file for one valgeografi path. Returns (path, result)."""
    name = "_".join(path) + f"_{count}.json"
    url = f"{BASE}/resultat/{valtillfalle}/{name}"
    return path, get(url, os.path.join(RAW, valtillfalle, name))


def build_party_table(national, min_share):
    """Return (parties, party_index, ovr_index) for the output file.

    Parties with at least min_share percent of the national vote are kept.
    All other parties are folded into "Övriga" (code OVR), which keeps the output small.
    """
    nat_total = national["rosterPaverkaMandat"]["antalRoster"] or 1
    parties, party_index = [], {}
    for code, abbr, name, color, n in parties_of(national):
        if code != "OVR" and n / nat_total >= min_share / 100:
            party_index[code] = len(parties)
            parties.append({"code": code, "abbr": abbr or code, "name": name, "color": color})
    ovr_index = len(parties)
    parties.append({"code": "OVR", "abbr": "ÖVR", "name": "Övriga partier", "color": "#BCBCBC"})
    return parties, party_index, ovr_index


def compact(r, meta, parties, party_index, ovr_index):
    """Reduce one result blob to the record stored in results.json.

    Vote counts are in the order of parties. Parties not in party_index are added to OVR.
    """
    votes = [0] * len(parties)
    for code, *_rest, n in parties_of(r):
        votes[party_index.get(code, ovr_index)] += n
    ej = r["rosterEjPaverkaMandat"]
    d = {
        "name": r["namn"],
        "votes": votes,
        "valid": r["rosterPaverkaMandat"]["antalRoster"],
        "blank": ej["blankaRoster"]["antalRoster"],
        "invalid": ej["antalRoster"],
        "total": to_int(r["totaltAntalRoster"]),
        "electorate": to_int(r["antalRostberattigade"]),
        "turnout": to_float(r["valdeltagande"]),
        "counted": r["antalValdistriktRaknade"],
        "toCount": r["antalValdistriktSomSkaRaknas"],
    }
    d.update(meta)
    return d


def kommun_name_from_lan(name):
    """Turn 'Gotlands län' into 'Gotlands kommun'. Other names are returned as they are."""
    if not name.endswith(" län"):
        return name
    return name[:-len(" län")].rstrip("s") + "s kommun"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--valtyp", default="RD", help="RD (riksdag), RF (region) or KF (kommun)")
    ap.add_argument("--count", default="S", choices=["S", "P"],
                    help="S = slutlig (final), P = preliminär")
    ap.add_argument("--valtillfalle", default="val2026")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--min-share", type=float, default=0.1,
                    help="keep parties with at least this national share in %% (default 0.1)")
    args = ap.parse_args()

    vt, cnt, vtf = args.valtyp, args.count, args.valtillfalle
    geo = get(f"{BASE}/valgeografi/valgeografi_{vtf}.json",
              os.path.join(RAW, vtf, "valgeografi.json"))
    root = next(n for n in geo["valgeografi"] if n["kod"] == vt)

    nodes = []
    walk(root, [vt], nodes)
    districts = [(p, n) for p, n in nodes if n["typ"] == "VALDISTRIKT"]
    kommuner = [(p, n) for p, n in nodes if n["typ"] == "KOMMUN"]
    print(f"{vt}: {len(districts)} valdistrikt, {len(kommuner)} kommuner", file=sys.stderr)

    todo = [[vt]] + [p for p, _ in nodes]
    fetch = functools.partial(fetch_result, valtillfalle=vtf, count=cnt)
    results = {}
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(fetch, p) for p in todo]
        for i, f in enumerate(concurrent.futures.as_completed(futs), 1):
            p, r = f.result()
            results[tuple(p)] = r
            if i % 250 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)} fetched ({time.time() - t0:.0f}s)", file=sys.stderr)

    national = results[(vt,)]
    parties, party_index, ovr_index = build_party_table(national, args.min_share)
    reduce = functools.partial(compact, parties=parties, party_index=party_index,
                               ovr_index=ovr_index)

    out = {
        "valtyp": vt,
        "count": "slutlig" if cnt == "S" else "preliminär",
        "date": national["valdatum"],
        "updated": national["senasteUppdateringstid"],
        "parties": parties,
        "riket": reduce(national, {}),
        "valkretsar": {},
        "kommuner": {},
        "districts": {},
    }
    for p, n in nodes:
        r = results[tuple(p)]
        if n["typ"] in ("RIKSDAGSVALKRETS", "LAN", "REGION"):
            out["valkretsar"][n["kod"]] = reduce(r, {})
        elif n["typ"] == "KOMMUN":
            out["kommuner"][n["kod"]] = reduce(r, {"valkrets": p[1]})
        elif n["typ"] == "VALDISTRIKT":
            out["districts"][n["kod"]] = reduce(r, {"kommun": n["kod"][:4]})
    # Gotland has no KOMMUN node. Its districts sit directly under the valkrets,
    # so the valkrets result doubles as the kommun result.
    for code, d in out["districts"].items():
        if d["kommun"] not in out["kommuner"]:
            vk = [p for p, n in nodes if n["typ"] == "VALDISTRIKT" and n["kod"] == code][0][1]
            r = results[(vt, vk)]
            k = reduce(r, {"valkrets": vk})
            k["name"] = kommun_name_from_lan(r["namn"])
            out["kommuner"][d["kommun"]] = k

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB): "
          f"{len(out['districts'])} districts, {len(out['kommuner'])} kommuner, "
          f"{len(parties)} parties", file=sys.stderr)


if __name__ == "__main__":
    main()
