/* Valkarta: an interactive map of the Swedish election result.
 * Plain d3 and topojson-client, no build step.
 * The data in data/ comes from scripts/fetch_results.py and scripts/build_geo.py.
 */
(async function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const fmtInt = new Intl.NumberFormat("sv-SE");
  const svNumber = (v, digits) =>
    v.toLocaleString("sv-SE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const fmtPct = (v, digits = 1) => (v == null || Number.isNaN(v)) ? "–" : svNumber(v, digits) + " %";
  const fmtDelta = (v) => (v > 0 ? "+" : "") + svNumber(v, 1);

  // ----------------------------------------------------------------- data ---
  let topo, R;
  try {
    [topo, R] = await Promise.all([
      d3.json("data/districts.topojson"),
      d3.json("data/results.json"),
    ]);
  } catch (e) {
    $("#loading").textContent = "Kunde inte läsa data/. " +
      "Kör scripts/fetch_results.py och scripts/build_geo.py först. (" + e.message + ")";
    return;
  }

  const parties = R.parties;  // [{code, abbr, name, color}]
  const OVR = parties.findIndex(p => p.code === "OVR");
  const partyIndex = new Map(parties.map((p, i) => [p.abbr.toLowerCase(), i]));
  parties.forEach((p, i) => partyIndex.set(p.code.toLowerCase(), i));

  // The blocks are fixed: S, V, MP and C on the left, M, SD, KD and L on the right.
  const blocks = new Map();  // abbr -> "L" | "R"
  for (const a of ["S", "V", "MP", "C"]) blocks.set(a, "L");
  for (const a of ["M", "SD", "KD", "L"]) blocks.set(a, "R");

  function statsOf(rec) {
    const valid = rec.valid || 1;
    const share = rec.votes.map(v => 100 * v / valid);
    let left = 0, right = 0, winner = -1, winnerShare = -1;
    parties.forEach((p, i) => {
      const b = blocks.get(p.abbr);
      if (b === "L") left += share[i];
      else if (b === "R") right += share[i];
      if (i !== OVR && share[i] > winnerShare) { winnerShare = share[i]; winner = i; }
    });
    return { share, left, right, turnout: rec.turnout, winner, winnerShare, margin: left - right };
  }

  const levels = {
    kommun: { label: "kommuner", records: R.kommuner },
    distrikt: { label: "valdistrikt", records: R.districts },
  };

  // ------------------------------------------------------------- geometry ---
  // d3-geo reads a counter-clockwise ring as "everything outside the ring".
  // A few small rings come out counter-clockwise after simplification.
  // So every polygon is rewound: exterior rings clockwise (area below 2 pi), holes the other way.
  function rewindRing(ring, exterior) {
    const area = d3.geoArea({ type: "Polygon", coordinates: [ring] });
    return (area > 2 * Math.PI) === exterior ? ring.slice().reverse() : ring;
  }
  function rewind(geom) {
    if (!geom) return geom;
    if (geom.type === "Polygon") {
      geom.coordinates = geom.coordinates.map((r, i) => rewindRing(r, i === 0));
    } else if (geom.type === "MultiPolygon") {
      geom.coordinates = geom.coordinates.map(p => p.map((r, i) => rewindRing(r, i === 0)));
    }
    return geom;
  }
  const districtGeoms = topo.objects.districts.geometries;
  const districtFC = topojson.feature(topo, topo.objects.districts);
  districtFC.features.forEach(f => rewind(f.geometry));
  const byKommun = d3.group(districtGeoms, g => g.properties.kommun);
  const kommunFeatures = [...byKommun].map(([kod, geoms]) => ({
    type: "Feature",
    id: kod,
    properties: { id: kod, name: geoms[0].properties.kommunName, kommun: kod },
    geometry: rewind(topojson.merge(topo, geoms)),
  }));
  const districtFeatures = districtFC.features.map(f => {
    f.properties.kommun = f.properties.kommun || f.id.slice(0, 4);
    return f;
  });
  const features = { kommun: kommunFeatures, distrikt: districtFeatures };
  const featureById = {
    kommun: new Map(kommunFeatures.map(f => [f.id, f])),
    distrikt: new Map(districtFeatures.map(f => [f.id, f])),
  };
  const districtsObj = topo.objects.districts;
  const kommunMesh = topojson.mesh(topo, districtsObj,
    (a, b) => a.properties.kommun !== b.properties.kommun);
  const lanMesh = topojson.mesh(topo, districtsObj, (a, b) => a.properties.lan !== b.properties.lan);
  const outline = topojson.mesh(topo, districtsObj, (a, b) => a === b);

  // ------------------------------------------------------------------ svg ---
  const svg = d3.select("#map");
  const zoomLayer = d3.select("#zoom-layer");
  const gAreas = d3.select("#areas");
  const gBorders = d3.select("#borders");
  const gSel = d3.select("#selection");
  const wrap = $("#map-wrap");

  // Web Mercator, so that the OpenStreetMap tiles line up under the districts.
  const projection = d3.geoMercator();
  const path = d3.geoPath(projection);
  let width = 0, height = 0;
  let transform = d3.zoomIdentity;

  const zoom = d3.zoom().scaleExtent([1, 8000]).on("zoom", (ev) => {
    transform = ev.transform;
    zoomLayer.attr("transform", transform);
    drawTiles();
  });
  svg.call(zoom).on("dblclick.zoom", null);
  $("#zoom-in").onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 2);
  $("#zoom-out").onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 0.5);
  $("#zoom-reset").onclick = () =>
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);

  function fit() {
    width = wrap.clientWidth; height = wrap.clientHeight;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    projection.fitExtent([[12, 12], [width - 12, height - 12]], outline);
    pathCache.kommun = null; pathCache.distrikt = null;
    drawAreas(); drawBorders(); drawTiles();
  }

  // ---------------------------------------------------------------- tiles ---
  // The raster basemap under the districts.
  // The projection maps lon/lat to screen pixels.
  // The tile pyramid is the same Mercator world, scaled so that one 256 px tile at zoom z
  // covers 1/2^z of it.
  const TILE = 256;
  const OSM = {
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    max: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" ' +
      'rel="noopener">OpenStreetMap</a> contributors',
  };
  const gTiles = d3.select("#tiles");
  function drawTiles() {
    if (!state.basemap) { gTiles.selectAll("image").remove(); return; }
    const bm = OSM;
    const world = 2 * Math.PI * projection.scale() * transform.k;  // full Mercator world in px
    const z = Math.max(0, Math.min(bm.max, Math.round(Math.log2(world / TILE))));
    const n = 2 ** z, size = world / n;
    const [tx, ty] = transform.apply(projection.translate());  // where lon 0, lat 0 lands
    const x0 = tx - world / 2, y0 = ty - world / 2;  // top-left corner of the world
    const xMin = Math.max(0, Math.floor(-x0 / size));
    const xMax = Math.min(n - 1, Math.floor((width - x0) / size));
    const yMin = Math.max(0, Math.floor(-y0 / size));
    const yMax = Math.min(n - 1, Math.floor((height - y0) / size));
    const tiles = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) tiles.push({ z, x, y, key: `${z}/${x}/${y}` });
    }
    gTiles.selectAll("image").data(tiles, d => d.key).join(
      enter => enter.append("image").attr("href", d => bm.url(d.z, d.x, d.y)),
      update => update,
      exit => exit.remove())
      .attr("x", d => x0 + d.x * size).attr("y", d => y0 + d.y * size)
      .attr("width", size + 0.5).attr("height", size + 0.5);  // the overlap hides seams
  }
  function setBasemap(on) {
    state.basemap = on;
    document.body.classList.toggle("basemap", on);
    $("#basemap-row").hidden = !on;
    $("#basemap-on").setAttribute("aria-pressed", on);
    const attr = $("#attribution");
    attr.hidden = !on;
    if (on) attr.innerHTML = OSM.attribution;
    drawTiles();
    writeHash();
  }
  const pathCache = { kommun: null, distrikt: null };
  function pathsFor(level) {
    if (!pathCache[level]) pathCache[level] = new Map(features[level].map(f => [f.id, path(f)]));
    return pathCache[level];
  }

  // ---------------------------------------------------------------- state ---
  const state = {
    level: "kommun",
    mode: "winner",     // winner | party | block | turnout
    party: parties.findIndex(p => p.abbr === "SD"),
    filter: null,       // compiled filter or null
    conditions: [],     // [{ lhs, op, rhs }] rows of the condition builder
    selected: null,     // { level, id }
    listShown: 60,
    basemap: false,     // show OpenStreetMap tiles under the districts
    fillOpacity: 0.6,   // area fill opacity while the basemap is on
  };
  let stats = { kommun: new Map(), distrikt: new Map() };
  function recomputeStats() {
    for (const lvl of Object.keys(levels)) {
      stats[lvl] = new Map();
      for (const [code, rec] of Object.entries(levels[lvl].records)) {
        stats[lvl].set(code, statsOf(rec));
      }
    }
  }
  recomputeStats();

  // -------------------------------------------------------------- colours ---
  const MISSING = "#d9d9d9";
  let scale = null;  // the current colour scale, also used by the legend

  // A sequential ramp for one party: light neutral, the party colour, then a darker shade.
  function partyRamp(color) {
    const c = d3.color(color);
    const dark = d3.lab(c); dark.l = Math.max(18, dark.l - 28);
    return d3.piecewise(d3.interpolateLab, ["#f4f1ec", c.formatHex(), dark.formatHex()]);
  }
  const blockRamp = d3.piecewise(d3.interpolateLab,
    ["#1d4f91", "#7ea4d6", "#e6e6e6", "#e08a8a", "#b71c1c"]);
  const turnoutRamp = t => d3.interpolateLab("#f4f1ec", "#2d5c3a")(t);

  function metric(s) {
    switch (state.mode) {
      case "winner": return s.winnerShare;
      case "party": return s.share[state.party];
      case "block": return s.margin;
      case "turnout": return s.turnout;
    }
  }

  const isNumber = v => v != null && !Number.isNaN(v);
  function buildScale() {
    const all = [...stats[state.level].values()];
    // The scale spans the areas that pass the filter.
    // With "SD at most 10" the ramp then spreads across 0 to 10, and the matches are readable.
    const passing = all.filter(st => !state.filter || state.filter.test(st));
    const values = passing.map(metric).filter(isNumber);
    if (values.length < 5) values.push(...all.map(metric).filter(isNumber));
    if (state.mode === "party") {
      const sorted = values.sort(d3.ascending);
      const lo = Math.floor(d3.quantile(sorted, 0.01));
      const hi = Math.max(lo + 2, Math.ceil(d3.quantile(sorted, 0.99)));
      scale = d3.scaleSequential(partyRamp(parties[state.party].color)).domain([lo, hi]).clamp(true);
    } else if (state.mode === "block") {
      const spread = d3.quantile(values.map(Math.abs).sort(d3.ascending), 0.98);
      const m = Math.max(10, Math.ceil(spread / 10) * 10);
      scale = d3.scaleDiverging(blockRamp).domain([-m, 0, m]).clamp(true);
    } else if (state.mode === "turnout") {
      const sorted = values.sort(d3.ascending);
      const lo = Math.floor(d3.quantile(sorted, 0.02) / 5) * 5;
      const hi = Math.max(lo + 5, Math.ceil(d3.quantile(sorted, 0.99)));
      scale = d3.scaleSequential(turnoutRamp).domain([lo, hi]).clamp(true);
    } else {
      scale = null;
    }
  }

  function matches(id) {
    const s = stats[state.level].get(id);
    return !!s && (!state.filter || state.filter.test(s));
  }
  function fillFor(id) {
    const s = stats[state.level].get(id);
    if (!s) return MISSING;
    switch (state.mode) {
      case "winner": return s.winner >= 0 ? parties[s.winner].color : MISSING;
      case "party": return scale(s.share[state.party]);
      case "block": return scale(s.margin);
      case "turnout": return s.turnout == null ? MISSING : scale(s.turnout);
    }
  }

  // -------------------------------------------------------------- drawing ---
  function drawAreas() {
    const lvl = state.level;
    const d = pathsFor(lvl);
    gAreas.attr("class", "level-" + lvl)
      .selectAll("path")
      .data(features[lvl], f => f.id)
      .join("path")
      .attr("d", f => d.get(f.id))
      .attr("data-id", f => f.id);
    recolor();
    drawSelection();
  }

  function drawBorders() {
    gBorders.selectAll("*").remove();
    gBorders.append("path").attr("class", "border kommun").attr("d", path(kommunMesh));
    gBorders.append("path").attr("class", "border lan").attr("d", path(lanMesh));
  }

  function recolor() {
    writeHash();
    buildScale();
    gAreas.selectAll("path")
      .attr("fill", f => fillFor(f.id))
      .classed("nomatch", f => !matches(f.id));
    drawLegend();
    drawList();
    updateFilterStatus();
  }

  function drawSelection() {
    gSel.selectAll("*").remove();
    if (!state.selected) return;
    const f = featureById[state.selected.level]?.get(state.selected.id);
    if (!f) return;
    gSel.append("path").attr("class", "selected")
      .attr("d", pathsFor(state.selected.level).get(f.id));
  }

  function zoomTo(feature, scaleFactor = 0.6) {
    const [[x0, y0], [x1, y1]] = path.bounds(feature);
    const k = Math.min(8000, scaleFactor / Math.max((x1 - x0) / width, (y1 - y0) / height));
    const t = d3.zoomIdentity.translate(width / 2, height / 2).scale(k)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    svg.transition().duration(600).call(zoom.transform, t);
  }

  // --------------------------------------------------------------- legend ---
  const modeHints = {
    winner: () => "Varje område får färgen på det parti som fick flest röster där.",
    party: () => `Färgen visar hur stor andel av rösterna ${parties[state.party].abbr} fick ` +
      "i området: ljus = liten andel, mörk = stor andel.",
    block: () => "Färgen visar vilket block som är störst i området och med hur mycket: " +
      "rött = vänsterblocket (S, V, C, MP) leder, blått = högerblocket (M, SD, KD, L) leder, " +
      "grått = jämnt.",
    turnout: () => "Färgen visar hur stor andel av de röstberättigade som röstade: " +
      "ljus = lågt valdeltagande, mörk = högt.",
  };
  function element(tag, className) {
    const el = document.createElement(tag);
    el.className = className;
    return el;
  }
  function drawLegend() {
    $("#mode-hint").textContent = modeHints[state.mode]();
    const el = $("#legend");
    el.innerHTML = "";
    const title = element("div", "legend-title");
    if (state.mode === "winner") {
      title.textContent = "Största parti";
      el.appendChild(title);
      const present = new Set([...stats[state.level].values()].map(s => s.winner));
      for (const i of [...present].filter(i => i >= 0).sort((a, b) => a - b)) {
        const row = element("div", "legend-row");
        row.innerHTML =
          `<span class="swatch" style="background:${parties[i].color}"></span>${parties[i].abbr}`;
        el.appendChild(row);
      }
      return;
    }
    const [lo, hi] = [scale.domain()[0], scale.domain()[scale.domain().length - 1]];
    if (state.mode === "party") title.textContent = `Andel röster på ${parties[state.party].abbr}`;
    if (state.mode === "block") title.textContent = "Blockets försprång, procentenheter";
    if (state.mode === "turnout") title.textContent = "Andel röstberättigade som röstade";
    el.appendChild(title);
    const bar = element("div", "legend-bar");
    const stops = d3.range(0, 1.001, 0.1).map(t => scale(lo + t * (hi - lo)));
    bar.style.background = `linear-gradient(to right, ${stops.join(",")})`;
    el.appendChild(bar);
    const lab = element("div", "legend-labels");
    if (state.mode === "block") {
      lab.innerHTML = `<span>Höger +${hi}</span><span>jämnt</span><span>Vänster +${hi}</span>`;
    } else {
      lab.innerHTML = `<span>${lo > 0 ? "≤ " : ""}${fmtPct(lo, 0)} (ljus)</span>` +
        `<span>≥ ${fmtPct(hi, 0)} (mörk)</span>`;
    }
    el.appendChild(lab);
    if (state.filter) {
      const n = element("div", "legend-row");
      n.innerHTML = `<span class="swatch nomatch"></span>Matchar inte filtret`;
      el.appendChild(n);
    }
  }

  // -------------------------------------------------------------- tooltip ---
  const tip = $("#tooltip");
  function areaLabel(level, id) {
    if (level === "kommun") return R.kommuner[id]?.name || id;
    const rec = R.districts[id];
    if (!rec) return id;
    return `${rec.name} <span class="muted">· ${R.kommuner[rec.kommun]?.name || rec.kommun}</span>`;
  }
  function showTip(ev, id) {
    const s = stats[state.level].get(id);
    if (!s) { tip.hidden = true; return; }
    const top = parties.map((p, i) => [p, s.share[i]])
      .filter(([p]) => p.code !== "OVR")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    const rows = top.map(([p, v]) =>
      `<span><i class="swatch" style="background:${p.color}"></i>${p.abbr}</span><b>${fmtPct(v)}</b>`);
    let match = "";
    if (state.filter) {
      match = state.filter.test(s)
        ? `<div class="tip-match yes">✓ Matchar filtret</div>`
        : `<div class="tip-match no">✗ Matchar inte filtret</div>`;
    }
    tip.innerHTML = `<div class="tip-title">${areaLabel(state.level, id)}</div>` +
      `<div class="tip-blocks"><span class="left">Vänster ${fmtPct(s.left)}</span>` +
      `<span class="right">Höger ${fmtPct(s.right)}</span></div>` +
      `<div class="tip-bar"><span class="left" style="width:${s.left}%"></span>` +
      `<span class="right" style="width:${s.right}%"></span></div>` +
      `<div class="tip-rows">${rows.join("")}</div>` +
      `<div class="tip-foot">Valdeltagande ${fmtPct(s.turnout)}</div>` +
      match;
    tip.hidden = false;
    moveTip(ev);
  }
  function moveTip(ev) {
    // On a phone the box is docked at the bottom of the map (see the CSS).
    // A box that follows the finger runs off the screen.
    if (isMobile()) { tip.classList.add("docked"); tip.style.transform = ""; return; }
    tip.classList.remove("docked");
    const r = wrap.getBoundingClientRect();
    let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
    if (x + tip.offsetWidth > r.width - 8) x = ev.clientX - r.left - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > r.height - 8) y = ev.clientY - r.top - tip.offsetHeight - 14;
    x = Math.max(8, Math.min(x, r.width - tip.offsetWidth - 8));
    y = Math.max(8, Math.min(y, r.height - tip.offsetHeight - 8));
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }
  // A tap on water or empty map hides a docked tooltip.
  svg.on("click.tip", ev => { if (!ev.target.dataset.id) tip.hidden = true; });
  gAreas.on("mouseover", ev => { const id = ev.target.dataset.id; if (id) showTip(ev, id); })
    .on("mousemove", ev => { if (!tip.hidden) moveTip(ev); })
    .on("mouseout", () => { tip.hidden = true; })
    .on("click", ev => {
      const id = ev.target.dataset.id;
      if (id) { select(state.level, id); showTip(ev, id); }
    })
    .on("dblclick", ev => {
      const id = ev.target.dataset.id;
      if (!id) return;
      const f = featureById[state.level].get(id);
      if (state.level === "kommun") { setLevel("distrikt"); select("kommun", id); }
      zoomTo(f);
    });

  // ------------------------------------------------------------ selection ---
  function select(level, id, doZoom = false) {
    state.selected = { level, id };
    drawSelection();
    drawDetail();
    writeHash();
    if (doZoom) zoomTo(featureById[level].get(id));
  }

  function parentLabel(level, rec) {
    if (level === "distrikt") {
      const kommun = R.kommuner[rec.kommun];
      const valkrets = R.valkretsar[kommun?.valkrets]?.name || "";
      return `<span class="muted">${kommun?.name || ""} · valkrets ${valkrets}</span>`;
    }
    return `<span class="muted">${R.valkretsar[rec.valkrets]?.name || ""}</span>`;
  }

  function drawDetail() {
    const el = $("#detail");
    if (!state.selected) { el.hidden = true; return; }
    const { level, id } = state.selected;
    const rec = levels[level].records[id];
    const s = stats[level].get(id);
    if (!rec || !s) { el.hidden = true; return; }
    const riket = statsOf(R.riket);
    const rows = parties
      .map((p, i) => ({
        p, votes: rec.votes[i], share: s.share[i], delta: s.share[i] - riket.share[i],
      }))
      .filter(r => r.votes > 0)
      .sort((a, b) => b.votes - a.votes);
    const max = rows[0]?.share || 1;
    const electorate = rec.electorate != null ? fmtInt.format(rec.electorate) : "–";
    const note = level === "kommun" ? "Inkl. uppsamlingsdistrikt." : "";
    el.innerHTML = `
      <div class="detail-head">
        <div><div class="detail-title">${rec.name}</div>${parentLabel(level, rec)}</div>
        <div class="detail-actions">
          <button class="link" id="detail-zoom">Zooma</button>
          <button class="link" id="detail-close">×</button>
        </div>
      </div>
      <div class="detail-facts">
        <span>Giltiga röster <b>${fmtInt.format(rec.valid)}</b></span>
        <span>Deltagande <b>${fmtPct(rec.turnout)}</b></span>
        <span>Röstberättigade <b>${electorate}</b></span>
        ${level === "kommun" ? `<span>Valdistrikt <b>${rec.counted}</b></span>` : ""}
      </div>
      <div class="bars">
        ${rows.map(r => `
          <div class="bar-row" title="${r.p.name}">
            <span class="bar-label">${r.p.abbr}</span>
            <span class="bar-track">
              <span class="bar"
                style="width:${(100 * r.share / max).toFixed(1)}%;background:${r.p.color}"></span>
            </span>
            <span class="bar-value">${fmtPct(r.share)}</span>
            <span class="bar-delta ${r.delta >= 0 ? "up" : "down"}">${fmtDelta(r.delta)}</span>
          </div>`).join("")}
      </div>
      <div class="block-bar" title="Vänster ${fmtPct(s.left)} / Höger ${fmtPct(s.right)}">
        <span class="left" style="width:${s.left}%"></span>
        <span class="right" style="width:${s.right}%"></span>
      </div>
      <div class="block-labels">
        <span>Vänster ${fmtPct(s.left)}</span><span>Höger ${fmtPct(s.right)}</span>
      </div>
      <p class="hint">Δ = jämfört med riket. ${note}</p>
    `;
    el.hidden = false;
    $("#detail-zoom").onclick = () => zoomTo(featureById[level].get(id));
    $("#detail-close").onclick = () => {
      state.selected = null; drawSelection(); drawDetail(); writeHash();
    };
  }

  // ----------------------------------------------------------------- list ---
  let listRows = [];
  function drawList() {
    const lvl = state.level;
    const rows = [];
    for (const [id, s] of stats[lvl]) {
      if (!featureById[lvl].has(id)) continue;  // uppsamlingsdistrikt have no map area
      if (state.filter && !state.filter.test(s)) continue;
      rows.push({ id, s, v: metric(s) });
    }
    rows.sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
    listRows = rows;
    state.listShown = 60;
    renderList();
    const mapped = [...stats[lvl].keys()].filter(id => featureById[lvl].has(id));
    const total = mapped.length;
    const votes = d3.sum(rows, r => levels[lvl].records[r.id].valid);
    const allVotes = d3.sum(mapped, id => levels[lvl].records[id].valid);
    $("#list-meta").textContent = state.filter
      ? `${fmtInt.format(rows.length)} av ${fmtInt.format(total)} ${levels[lvl].label} · ` +
        `${fmtPct(100 * votes / allVotes)} av rösterna`
      : `${fmtInt.format(total)} ${levels[lvl].label}, sorterade efter ${modeLabel()}`;
  }
  function modeLabel() {
    return {
      winner: "största partiets andel",
      party: parties[state.party].abbr + "-andel",
      block: "blockmarginal",
      turnout: "valdeltagande",
    }[state.mode];
  }
  function listValue(r) {
    if (state.mode === "block") return (r.v > 0 ? "Vänster +" : "Höger +") + fmtPct(Math.abs(r.v));
    const prefix = state.mode === "winner" ? parties[r.s.winner]?.abbr + " " : "";
    return prefix + fmtPct(r.v);
  }
  function renderList() {
    const ol = $("#area-list");
    const lvl = state.level;
    ol.innerHTML = listRows.slice(0, state.listShown).map(r =>
      `<li data-id="${r.id}"><span>${areaLabel(lvl, r.id)}</span><b>${listValue(r)}</b></li>`).join("");
    $("#list-more").hidden = listRows.length <= state.listShown;
  }
  $("#list-more").onclick = () => { state.listShown += 100; renderList(); };
  $("#area-list").addEventListener("click", ev => {
    const li = ev.target.closest("li"); if (!li) return;
    if (isMobile()) setView("map");
    select(state.level, li.dataset.id, true);
  });

  // ------------------------------------------------------------- controls ---
  function setActive(container, value) {
    container.querySelectorAll("button")
      .forEach(x => x.classList.toggle("active", x.dataset.value === value));
  }
  function segmented(id, onChange) {
    const el = $(id);
    el.addEventListener("click", ev => {
      const b = ev.target.closest("button"); if (!b) return;
      setActive(el, b.dataset.value);
      onChange(b.dataset.value);
    });
  }
  function setLevel(lvl) {
    if (state.level === lvl) return;
    state.level = lvl;
    setActive($("#level"), lvl);
    drawAreas();
  }
  segmented("#level", setLevel);
  segmented("#mode", v => { state.mode = v; $("#party-row").hidden = v !== "party"; recolor(); });

  const sel = $("#party-select");
  parties.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = `${p.abbr} – ${p.name}`;
    sel.appendChild(o);
  });
  sel.value = state.party;
  sel.onchange = () => { state.party = +sel.value; recolor(); };

  // The condition builder. Each row is { lhs, op, rhs }.
  // lhs and rhs are identifiers that the expression compiler in filter.js understands
  // (a party abbreviation, vänster, höger, valdeltagande).
  // For rhs, a number in percent is also valid.
  // The rows are joined with "&" and compiled as one expression.
  const SUBJECTS = [
    ...parties.filter(p => p.code !== "OVR")
      .map(p => ({ id: p.abbr, label: `${p.abbr} – ${p.name}`, short: p.abbr })),
    { id: "vänster", label: "Vänstern (S+V+C+MP)", short: "Vänstern" },
    { id: "höger", label: "Högern (M+SD+KD+L)", short: "Högern" },
    { id: "valdeltagande", label: "Valdeltagande", short: "Valdeltagande" },
  ];
  const subjectById = new Map(SUBJECTS.map(s => [s.id.toLowerCase(), s]));
  const OPERATORS = [
    { id: ">=", label: "minst", numeric: true },
    { id: "<=", label: "högst", numeric: true },
    { id: ">", label: "mer än", numeric: false },
    { id: "<", label: "mindre än", numeric: false },
  ];
  const isNumericOp = (op) => OPERATORS.find(o => o.id === op)?.numeric;
  const isSubject = (v) => subjectById.has(String(v).toLowerCase());
  function validCondition(c) {
    if (!c || !isSubject(c.lhs) || !OPERATORS.some(o => o.id === c.op)) return false;
    return isNumericOp(c.op) ? Number.isFinite(+c.rhs) : isSubject(c.rhs);
  }

  function conditionsToExpr(conds) {
    return conds.map(c => `${c.lhs} ${c.op} ${c.rhs}`).join(" & ");
  }
  function compileConditions() {
    if (!state.conditions.length) return null;
    try {
      return compileFilter(conditionsToExpr(state.conditions), { parties, partyIndex });
    } catch (e) {
      console.warn("filter", e);
      return null;
    }
  }
  function applyConditions() {
    state.conditions = state.conditions.filter(validCondition);
    state.filter = compileConditions();
    recolor();
  }
  function subjectOptions(selected) {
    const want = String(selected).toLowerCase();
    return SUBJECTS.map(s =>
      `<option value="${s.id}" title="${s.label}" ${s.id.toLowerCase() === want ? "selected" : ""}>` +
      `${s.short}</option>`).join("");
  }
  function operatorOptions(selected) {
    return OPERATORS.map(o =>
      `<option value="${o.id}" ${o.id === selected ? "selected" : ""}>${o.label}</option>`).join("");
  }
  function conditionRow(c, i) {
    const value = isNumericOp(c.op)
      ? `<span class="cond-value">` +
        `<input type="number" data-field="rhs" min="0" max="100" step="1" value="${c.rhs}">` +
        `<span class="unit">%</span></span>` +
        `<input type="range" class="cond-slider" data-field="rhs" min="0" max="100" step="1" ` +
        `value="${c.rhs}">`
      : `<select data-field="rhs">${subjectOptions(c.rhs)}</select>`;
    return `<div class="cond-row" data-i="${i}">
      <select data-field="lhs">${subjectOptions(c.lhs)}</select>
      <select data-field="op">${operatorOptions(c.op)}</select>
      ${value}
      <button class="cond-remove" title="Ta bort villkoret">×</button>
    </div>`;
  }
  function drawConditions() {
    $("#conditions").innerHTML = state.conditions.map(conditionRow).join("");
  }
  function updateFilterStatus() {
    const status = $("#filter-status");
    status.hidden = !state.filter;
    if (state.filter) {
      status.textContent = `Visar ${$("#list-meta").textContent}. Övriga områden skuggas.`;
    }
  }
  let condTimer;
  $("#conditions").addEventListener("input", ev => {
    const row = ev.target.closest(".cond-row"); if (!row) return;
    const c = state.conditions[+row.dataset.i];
    if (ev.target.dataset.field !== "rhs" || !isNumericOp(c.op)) return;
    c.rhs = Math.min(100, Math.max(0, +ev.target.value || 0));
    // The number box and the slider show the same value.
    row.querySelectorAll('[data-field="rhs"]').forEach(el => {
      if (el !== ev.target) el.value = c.rhs;
    });
    clearTimeout(condTimer); condTimer = setTimeout(applyConditions, 100);
  });
  $("#conditions").addEventListener("change", ev => {
    const row = ev.target.closest(".cond-row"); if (!row) return;
    const c = state.conditions[+row.dataset.i];
    const field = ev.target.dataset.field;
    if (field === "lhs") {
      c.lhs = ev.target.value;
    } else if (field === "op") {
      const wasNumeric = isNumericOp(c.op);
      c.op = ev.target.value;
      if (isNumericOp(c.op) !== wasNumeric) {
        c.rhs = isNumericOp(c.op) ? 10 : (c.lhs === "S" ? "M" : "S");
      }
      drawConditions();
    } else if (field === "rhs" && !isNumericOp(c.op)) {
      c.rhs = ev.target.value;
    }
    applyConditions();
  });
  $("#conditions").addEventListener("click", ev => {
    if (!ev.target.closest(".cond-remove")) return;
    state.conditions.splice(+ev.target.closest(".cond-row").dataset.i, 1);
    drawConditions(); applyConditions();
  });
  $("#cond-add").onclick = () => {
    state.conditions.push({ lhs: "SD", op: "<=", rhs: 10 });
    drawConditions(); applyConditions();
    $("#conditions .cond-row:last-child select").focus();
  };
  $("#presets").addEventListener("click", ev => {
    const b = ev.target.closest("button"); if (!b) return;
    state.conditions = JSON.parse(b.dataset.conds);
    drawConditions(); applyConditions();
  });

  function drawBlocks() {
    const side = (b) => parties.filter(p => blocks.get(p.abbr) === b)
      .map(p => `<span class="chip" title="${p.name}">` +
        `<i class="swatch" style="background:${p.color}"></i>${p.abbr}</span>`)
      .join("");
    $("#blocks").innerHTML =
      `<div class="block-line"><span class="block-name left">Vänster</span>${side("L")}</div>` +
      `<div class="block-line"><span class="block-name right">Höger</span>${side("R")}</div>`;
  }

  // On a phone only one of the map and the panel is visible (see the CSS).
  // The bar at the bottom switches between them.
  // The map has no size while it is hidden, so it is fitted again when it comes back.
  const mobileNav = $("#mobile-nav");
  function setView(view) {
    document.body.classList.toggle("view-panel", view === "panel");
    mobileNav.querySelectorAll("button")
      .forEach(b => b.classList.toggle("active", b.dataset.view === view));
    if (view === "map" && wrap.clientWidth && wrap.clientWidth !== width) fit();
  }
  mobileNav.addEventListener("click", ev => {
    const b = ev.target.closest("button");
    if (b) setView(b.dataset.view);
  });
  const isMobile = () => getComputedStyle(mobileNav).display !== "none";

  $("#basemap-on").addEventListener("click", () => setBasemap(!state.basemap));
  $("#fill-opacity").addEventListener("input", ev => {
    state.fillOpacity = +ev.target.value;
    document.body.style.setProperty("--fill-opacity", state.fillOpacity);
    writeHash();
  });

  // --------------------------------------------------------------- search ---
  const searchIndex = [
    ...Object.entries(R.kommuner)
      .map(([id, r]) => ({ level: "kommun", id, name: r.name, sub: "kommun" })),
    ...Object.entries(R.districts)
      .filter(([id]) => featureById.distrikt.has(id))
      .map(([id, r]) => ({
        level: "distrikt", id, name: r.name, sub: R.kommuner[r.kommun]?.name || "",
      })),
  ];
  const searchInput = $("#search"), searchList = $("#search-results");
  const kommunFirst = (a, b) => (a.level === "kommun" ? 0 : 1) - (b.level === "kommun" ? 0 : 1);
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) { searchList.hidden = true; return; }
    const hits = searchIndex
      .filter(x => x.name.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q))
      .sort((a, b) => kommunFirst(a, b) || a.name.localeCompare(b.name, "sv"))
      .slice(0, 12);
    searchList.innerHTML = hits.map(h =>
      `<li data-level="${h.level}" data-id="${h.id}">` +
      `<span>${h.name}</span><span class="muted">${h.sub}</span></li>`)
      .join("") || `<li class="muted">Inga träffar</li>`;
    searchList.hidden = false;
  });
  searchList.addEventListener("click", ev => {
    const li = ev.target.closest("li[data-id]"); if (!li) return;
    setLevel(li.dataset.level);
    if (isMobile()) setView("map");
    select(li.dataset.level, li.dataset.id, true);
    searchList.hidden = true; searchInput.value = "";
  });
  document.addEventListener("click", ev => {
    if (!ev.target.closest("#search, #search-results")) searchList.hidden = true;
  });

  // ------------------------------------------------------------ url state ---
  // Example: #level=distrikt&mode=party&party=SD&f=SD,<=,10;vänster,>,höger&sel=1082&bg=osm&fill=0.5
  let hashTimer;
  function writeHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const q = new URLSearchParams();
      if (state.level !== "kommun") q.set("level", state.level);
      if (state.mode !== "winner") q.set("mode", state.mode);
      if (state.mode === "party") q.set("party", parties[state.party].abbr);
      if (state.conditions.length) {
        q.set("f", state.conditions.map(c => `${c.lhs},${c.op},${c.rhs}`).join(";"));
      }
      if (state.selected) q.set("sel", state.selected.id);
      if (state.basemap) q.set("bg", "osm");
      if (state.fillOpacity !== 0.6) q.set("fill", state.fillOpacity);
      history.replaceState(null, "", q.toString() ? "#" + q.toString() : location.pathname);
    }, 150);
  }
  function parseCondition(text) {
    const [lhs, op, rhs] = text.split(",");
    return {
      lhs: subjectById.get((lhs || "").toLowerCase())?.id,
      op,
      rhs: isNumericOp(op) ? +rhs : subjectById.get((rhs || "").toLowerCase())?.id,
    };
  }
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    if (q.get("level") in levels) state.level = q.get("level");
    if (["winner", "party", "block", "turnout"].includes(q.get("mode"))) state.mode = q.get("mode");
    const pi = partyIndex.get((q.get("party") || "").toLowerCase());
    if (pi !== undefined) state.party = pi;
    state.conditions = (q.get("f") || "").split(";").filter(Boolean)
      .map(parseCondition).filter(validCondition);
    if (q.get("bg")) state.basemap = true;
    const fill = +q.get("fill");
    if (q.get("fill") && !Number.isNaN(fill)) state.fillOpacity = Math.min(1, Math.max(0.2, fill));
    const sel = q.get("sel");
    if (sel) {
      const lvl = sel.length === 4 ? "kommun" : "distrikt";
      if (featureById[lvl].has(sel)) state.selected = { level: lvl, id: sel };
    }
  }

  // The free plan of Netlify injects a "Powered by Netlify" iframe, fixed to the bottom-right corner.
  // When it appears, a class on body lets the CSS keep the mobile nav and the attribution clear of it.
  function checkBadge() {
    if (!document.getElementById("nl-badge-frame")) return false;
    document.body.classList.add("nl-badge");
    return true;
  }
  if (!checkBadge()) {
    const badgeCheck = new MutationObserver(() => { if (checkBadge()) badgeCheck.disconnect(); });
    badgeCheck.observe(document.body, { childList: true });
    setTimeout(() => badgeCheck.disconnect(), 15000);
  }

  // ----------------------------------------------------------------- init ---
  readHash();
  drawBlocks();
  setActive($("#level"), state.level);
  setActive($("#mode"), state.mode);
  $("#party-row").hidden = state.mode !== "party";
  sel.value = state.party;
  drawConditions();
  state.filter = compileConditions();
  $("#fill-opacity").value = state.fillOpacity;
  document.body.style.setProperty("--fill-opacity", state.fillOpacity);
  setBasemap(state.basemap);
  $("#election-title").textContent = R.date.slice(0, 4);
  const valtyp = R.valtyp === "RD" ? "Riksdagsvalet" : R.valtyp;
  $("#election-meta").textContent =
    `${valtyp} ${R.date} · ${R.count} rösträkning · uppdaterad ${R.updated}`;
  $("#loading").remove();
  fit();
  drawDetail();
  if (state.selected) zoomTo(featureById[state.selected.level].get(state.selected.id));
  updateFilterStatus();
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, 150);
  });
})();
