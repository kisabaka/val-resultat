# Valkarta – interaktiv karta över riksdagsvalet 2026

*English version below: [In English](#in-english).*

Statisk webbsida (HTML/CSS/JS + d3 + topojson-client, inga ramverk) som visar det slutliga
resultatet i riksdagsvalet 2026 per kommun och valdistrikt.
Filtrera på parti, block och andelar, till exempel SD högst 10 % och S minst 30 %.
Knappen *Vägar & ortnamn* på kartan tänder OpenStreetMap under distrikten,
med ett reglage för hur täckande färgfälten ska vara.

## Kör

```sh
python3 -m http.server 8000
# öppna http://localhost:8000/
```

All data ligger förberäknad i `data/`, så sidan behöver ingen backend.

## Bygg om datan

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 1. Resultat per valdistrikt och kommun från resultat.val.se -> data/results.json
#    Cirka 7 000 JSON-filer, cachade i raw/.
#    Servern rate-limitar, så det tar cirka 30 minuter.
.venv/bin/python scripts/fetch_results.py            # --count P för preliminärt

# 2. Geometri. Ladda ner "Valdistrikt - hela Sverige" (zip) från
#    https://www.val.se/valresultat-och-statistik/statistik-och-data/radata-val-2026
#    och packa upp GeoJSON-filen i raw/.
#    Valmyndighetens distrikt sträcker sig långt ut i havet,
#    så de klipps mot en landmask (GADM 4.1, nivå 0):
curl -o raw/gadm41_SWE_0.json https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_SWE_0.json
.venv/bin/python scripts/clip_to_land.py raw/valdistrikt-riket-2026.geojson raw/gadm41_SWE_0.json \
    raw/valdistrikt-land.geojson

# 3. Förenkla och bygg TopoJSON -> data/districts.topojson
.venv/bin/python scripts/build_geo.py raw/valdistrikt-land.geojson
```

## Filter

Under *Visa bara områden där…* byggs filtret av rader utan syntax.
Välj **vad** (ett parti, Vänstern, Högern eller Valdeltagande),
**hur** (*minst*, *högst*, *mer än*, *mindre än*) och ett **värde**.
Värdet är procent med reglage, eller ett annat parti eller block för jämförelser som "M mer än S".
Alla rader måste stämma samtidigt.
Snabbknapparna (*SD under 10 %*, *Vänstern leder* och så vidare) fyller i färdiga rader.
Områden som inte matchar skuggas och listan visar träffarna.

Raderna översätts internt till uttryck (`SD <= 10 & vänster > höger`) som `js/filter.js` kompilerar.
De sparas i adressraden som `#f=SD,<=,10;vänster,>,höger`, så att en vy går att länka.

## Datakällor

* Resultat: `https://resultat.val.se/data/resultat/val2026/<path>_S.json`.
  Samma JSON som resultat.val.se själv läser. `_S` är slutlig räkning, `_P` preliminär.
* Valgeografi: `https://resultat.val.se/data/valgeografi/valgeografi_val2026.json`.
* Kartgränser: Valmyndighetens GeoJSON i SWEREF99 TM (EPSG:3006),
  klippt mot GADM:s Sverigekontur, omprojicerad till WGS84 och förenklad till cirka 5 MB TopoJSON.
  Webbläsaren ritar den med `d3.geoMercator`,
  så att OpenStreetMaps kartrutor hamnar rätt under distrikten.
* Bakgrundskarta: `tile.openstreetmap.org`, hämtad direkt av webbläsaren när läget är påslaget.
  OSM:s [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  tillåter lätt personlig användning.
  För en publik sajt med många besökare, peka `OSM.url` i `js/app.js` mot en egen tile-server.

Uppsamlingsdistrikt (förtids- och utlandsröster som räknas separat) saknar geometri.
Deras röster ingår i kommunsiffrorna men visas inte som egna områden.

Källa: Valmyndigheten (valresultat och valdistrikt), GADM (kustlinje),
© OpenStreetMap contributors (bakgrundskarta).

---

## In English

Valkarta is an interactive map of the final result of the Swedish general election (riksdagsvalet)
on 13 September 2026.
It shows the result per municipality (kommun) and per electoral district (valdistrikt).
The page is static HTML, CSS and JavaScript with d3 and topojson-client.
There is no framework and no backend. All data is precomputed in `data/`.

### Run

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

### What the page does

- **Level**: switch between municipalities and electoral districts.
  Double-click a municipality to zoom in and switch to its districts.
- **Colour**: the largest party, the vote share of one party, left block versus right block,
  or turnout.
  A line under the buttons explains the selected mode.
- **Filter** (*Visa bara områden där…*): build conditions from dropdowns, with no syntax.
  Select what (a party, the left block, the right block or turnout),
  how (at least, at most, more than, less than) and a value.
  The value is a percentage with a slider,
  or another party or block for comparisons such as "M more than S".
  All rows must be true at the same time.
  Areas that do not match are shaded and the list shows the matches.
- **Blocks**: left is S, V, C and MP; right is M, SD, KD and L. This is fixed.
- **Roads and place names** (*Vägar & ortnamn*): a button on the map that shows OpenStreetMap
  under the districts, with a slider for the opacity of the coloured areas.
- **Hover or tap** an area to see the name, the two block shares, the largest parties, the turnout
  and whether the area matches the filter.
  Click an area for the full breakdown in the panel.
- **Search** for a municipality or a district by name.
- The view (level, colour mode, filter, selection, basemap) is stored in the URL, so a view can be
  linked.
  Example: `#level=distrikt&mode=party&party=SD&f=SD,<=,10`.
- On a phone the map and the panel are separate views. Switch with the bar at the bottom.

### Rebuild the data

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 1. Results per district and municipality from resultat.val.se -> data/results.json
#    About 7 000 JSON files, cached in raw/.
#    The server rate-limits, so this takes about 30 minutes.
.venv/bin/python scripts/fetch_results.py            # --count P for the preliminary count

# 2. Geometry. Download "Valdistrikt - hela Sverige" (zip) from
#    https://www.val.se/valresultat-och-statistik/statistik-och-data/radata-val-2026
#    and unzip the GeoJSON file into raw/.
#    The official district polygons extend far out to sea,
#    so they are clipped against a land mask (GADM 4.1, level 0):
curl -o raw/gadm41_SWE_0.json https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_SWE_0.json
.venv/bin/python scripts/clip_to_land.py raw/valdistrikt-riket-2026.geojson raw/gadm41_SWE_0.json \
    raw/valdistrikt-land.geojson

# 3. Simplify and build the TopoJSON -> data/districts.topojson
.venv/bin/python scripts/build_geo.py raw/valdistrikt-land.geojson
```

### Data sources

- Results: `https://resultat.val.se/data/resultat/val2026/<path>_S.json`.
  This is the JSON that resultat.val.se reads itself.
  `_S` is the final count, `_P` the preliminary count.
- Electoral geography: `https://resultat.val.se/data/valgeografi/valgeografi_val2026.json`.
- Boundaries: the Election Authority's GeoJSON in SWEREF99 TM (EPSG:3006),
  clipped against the GADM outline of Sweden, reprojected to WGS84
  and simplified to a TopoJSON of about 5 MB.
  The browser draws it with `d3.geoMercator`, so the OpenStreetMap tiles line up under the districts.
- Basemap: `tile.openstreetmap.org`, requested by the browser when the basemap is on.
  The OSM [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  permits light personal use.
  For a public site with many visitors, point `OSM.url` in `js/app.js` to your own tile server.

Collection districts (uppsamlingsdistrikt, which count postal and early votes separately)
have no geometry.
Their votes are included in the municipality totals but they are not shown as areas.

Parties with less than 0.1 % of the national vote are grouped as "Övriga" (others).

Sources: Valmyndigheten (results and districts), GADM (coastline),
© OpenStreetMap contributors (basemap).
