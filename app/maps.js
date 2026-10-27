// ------------------------------------------------------------------
// Hole maps for the scoring app.
//
//  * Satellite (Esri World Imagery) or map (OpenStreetMap) view of each
//    hole, from the tee and green pins the committee placed.
//  * Your position from the phone's GPS as a blue dot, with a line and
//    the yardage to the centre of the green. Worked out on the phone —
//    nobody's location is sent anywhere.
//  * The committee's pin editor, with an import from OpenStreetMap for
//    courses that have been drawn there.
//  * "Save maps for offline", so the satellite view still works with no
//    signal on the far side of the course.
//
// Leaflet is loaded only when a map is first opened.
// ------------------------------------------------------------------
(function () {
  "use strict";

  const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
  const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
  const SAT_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const SAT_ATTR = "Imagery © Esri, Maxar, Earthstar Geographics";
  const MAP_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const MAP_ATTR = "© OpenStreetMap contributors";
  const YARDS_PER_METRE = 1.0936133;
  const OFF_COURSE_YARDS = 1500; // further than this from the green and you're not on the hole

  // ---------- maths ----------

  function metres(a, b) {
    const R = 6371008.8;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const yards = (a, b) => Math.round(metres(a, b) * YARDS_PER_METRE);

  const teeOf = g => g && g.tee_lat != null && g.tee_lng != null ? { lat: g.tee_lat, lng: g.tee_lng } : null;
  const greenOf = g => g && g.green_lat != null && g.green_lng != null ? { lat: g.green_lat, lng: g.green_lng } : null;

  // ---------- Leaflet, loaded on demand ----------

  let leafletReady = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletReady) return leafletReady;
    leafletReady = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = LEAFLET_CSS;
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = LEAFLET_JS;
      js.onload = () => resolve(window.L);
      js.onerror = () => { leafletReady = null; reject(new Error("The map couldn't load — check your signal.")); };
      document.head.appendChild(js);
    });
    return leafletReady;
  }

  function baseLayers(L) {
    return {
      sat: L.tileLayer(SAT_URL, { maxZoom: 20, maxNativeZoom: 19, attribution: SAT_ATTR }),
      map: L.tileLayer(MAP_URL, { maxZoom: 20, maxNativeZoom: 19, attribution: MAP_ATTR }),
    };
  }

  function pinIcon(L, kind, label) {
    return L.divIcon({
      className: "pin-icon",
      html: `<span class="pin pin-${kind}">${label || ""}</span>`,
      iconSize: [28, 28], iconAnchor: [14, 14],
    });
  }

  // ---------- GPS ----------

  const gps = { watchId: null, pos: null, listeners: new Set(), error: null };

  function startGps() {
    if (gps.watchId != null) return true;
    if (!("geolocation" in navigator)) { gps.error = "This phone can't share its location."; notify(); return false; }
    gps.watchId = navigator.geolocation.watchPosition(p => {
      gps.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: p.timestamp };
      gps.error = null;
      notify();
    }, err => {
      gps.error = err.code === 1 ? "Location is turned off for this site. Allow it in your phone's settings to see distances."
        : "Can't get a GPS fix yet — try in the open.";
      notify();
    }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
    return true;
  }

  function stopGps() {
    if (gps.watchId != null) navigator.geolocation.clearWatch(gps.watchId);
    gps.watchId = null;
  }

  function notify() { gps.listeners.forEach(fn => { try { fn(gps); } catch (e) { /* keep going */ } }); }
  function onGps(fn) { gps.listeners.add(fn); return () => gps.listeners.delete(fn); }

  // Yardage to the green centre for a hole, or null when there's no fix
  // or you're nowhere near it.
  function toGreen(geoRow) {
    const g = greenOf(geoRow);
    if (!g || !gps.pos) return null;
    const y = yards(gps.pos, g);
    if (y > OFF_COURSE_YARDS) return { off: true, yards: y };
    return { yards: y, acc: Math.round(gps.pos.acc * YARDS_PER_METRE) };
  }

  // ---------- the hole map (players) ----------

  let holeMap = null;

  // opts: { course, holes:[{hole,par,stroke_index,yards}], geo: Map(hole -> row), hole, onClose(hole) }
  async function openHoleMap(opts) {
    const host = document.getElementById("map-view");
    host.hidden = false;
    host.innerHTML = `
      <div class="mv-top">
        <button class="mv-btn" data-mv="close" aria-label="Close map">✕</button>
        <div class="mv-title" id="mv-title"></div>
        <button class="mv-btn" data-mv="layer" id="mv-layer">Map</button>
      </div>
      <div id="mv-map" class="mv-map"><div class="loading">Loading map…</div></div>
      <div class="mv-bottom">
        <button class="mv-btn" data-mv="prev" aria-label="Previous hole">‹</button>
        <div class="mv-yds" id="mv-yds"></div>
        <button class="mv-btn" data-mv="next" aria-label="Next hole">›</button>
      </div>
      <div class="mv-foot"><button class="mv-link" data-mv="offline" id="mv-offline">Save this course's maps for offline</button></div>`;
    let L;
    try { L = await loadLeaflet(); }
    catch (e) { document.getElementById("mv-map").innerHTML = `<div class="loading">${e.message}</div>`; return; }

    document.getElementById("mv-map").innerHTML = "";
    const map = L.map("mv-map", { zoomControl: false, attributionControl: true });
    L.control.zoom({ position: "topright" }).addTo(map);
    const layers = baseLayers(L);
    let current = "sat";
    layers.sat.addTo(map);

    const state = { hole: opts.hole, markers: [], me: null, acc: null, line: null };

    function draw() {
      state.markers.forEach(m => map.removeLayer(m));
      state.markers = [];
      if (state.line) { map.removeLayer(state.line); state.line = null; }
      const h = opts.holes.find(x => x.hole === state.hole) || {};
      const g = opts.geo.get(state.hole);
      const tee = teeOf(g), green = greenOf(g);
      document.getElementById("mv-title").innerHTML =
        `<b>Hole ${state.hole}</b> · Par ${h.par || "?"} · SI ${h.stroke_index || "?"}${h.yards ? ` · ${h.yards} yds` : ""}`;
      if (!green) {
        document.getElementById("mv-yds").innerHTML = `<span class="mv-note">This hole hasn't been mapped yet.</span>`;
        if (opts.course && opts.course.lat != null) map.setView([opts.course.lat, opts.course.lng], 16);
        else map.setView([51.2, -0.7], 13);
        return;
      }
      if (tee) state.markers.push(L.marker([tee.lat, tee.lng], { icon: pinIcon(L, "tee", "T"), interactive: false }).addTo(map));
      state.markers.push(L.marker([green.lat, green.lng], { icon: pinIcon(L, "green", "⚑"), interactive: false }).addTo(map));
      if (tee) {
        state.markers.push(L.polyline([[tee.lat, tee.lng], [green.lat, green.lng]], { color: "#ffffff", weight: 2, opacity: 0.6, dashArray: "4 6" }).addTo(map));
        map.fitBounds(L.latLngBounds([[tee.lat, tee.lng], [green.lat, green.lng]]).pad(0.25), { maxZoom: 18 });
      } else map.setView([green.lat, green.lng], 17);
      update();
    }

    function update() {
      const g = opts.geo.get(state.hole);
      const green = greenOf(g), tee = teeOf(g);
      const box = document.getElementById("mv-yds");
      if (!box) return;
      if (state.line) { map.removeLayer(state.line); state.line = null; }
      if (gps.pos) {
        const ll = [gps.pos.lat, gps.pos.lng];
        if (!state.me) {
          state.acc = L.circle(ll, { radius: gps.pos.acc, color: "#2f80ed", weight: 1, fillOpacity: 0.12 }).addTo(map);
          state.me = L.circleMarker(ll, { radius: 7, color: "#fff", weight: 2, fillColor: "#2f80ed", fillOpacity: 1 }).addTo(map);
        } else { state.me.setLatLng(ll); state.acc.setLatLng(ll).setRadius(gps.pos.acc); }
      }
      if (!green) return;
      const d = toGreen(g);
      if (d && !d.off) {
        state.line = L.polyline([[gps.pos.lat, gps.pos.lng], [green.lat, green.lng]], { color: "#f2c94c", weight: 3 }).addTo(map);
        box.innerHTML = `<div class="mv-big">${d.yards}<small> yds</small></div><div class="mv-note">to the middle of the green · GPS ±${d.acc} yds</div>`;
      } else {
        const fromTee = tee ? yards(tee, green) : null;
        box.innerHTML = `${fromTee ? `<div class="mv-big">${fromTee}<small> yds</small></div><div class="mv-note">tee to middle of the green</div>` : ""}
          <div class="mv-note">${gps.error ? gps.error : d && d.off ? "You're not on this hole — live distance shows when you are." : gps.watchId != null ? "Finding you…" : ""}</div>`;
      }
    }

    startGps();
    const off = onGps(update);
    draw();

    host.onclick = async e => {
      const b = e.target.closest("[data-mv]");
      if (!b) return;
      const a = b.dataset.mv;
      if (a === "close") { off(); map.remove(); host.hidden = true; host.innerHTML = ""; holeMap = null; if (opts.onClose) opts.onClose(state.hole); }
      if (a === "prev") { state.hole = state.hole === 1 ? 18 : state.hole - 1; draw(); }
      if (a === "next") { state.hole = state.hole === 18 ? 1 : state.hole + 1; draw(); }
      if (a === "layer") {
        map.removeLayer(layers[current]);
        current = current === "sat" ? "map" : "sat";
        layers[current].addTo(map);
        b.textContent = current === "sat" ? "Map" : "Satellite";
      }
      if (a === "offline") {
        b.disabled = true;
        const n = await prefetch(opts.geo, t => { b.textContent = `Saving maps… ${t}`; });
        b.textContent = n ? `Saved — ${n} map tiles on this phone` : "Nothing to save — no holes mapped";
      }
    };
    holeMap = { map, state };
  }

  // ---------- offline tiles ----------

  function tileXY(lat, lng, z) {
    const n = 2 ** z;
    const x = Math.floor((lng + 180) / 360 * n);
    const r = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
    return { x, y };
  }

  // Satellite tiles for every mapped hole at zooms 16–18, so the view
  // works on the course with no signal. The service worker keeps them.
  async function prefetch(geo, progress) {
    const urls = new Set();
    geo.forEach(g => {
      const pts = [teeOf(g), greenOf(g)].filter(Boolean);
      if (!pts.length) return;
      const pad = 0.0012;
      const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
      const box = { n: Math.max(...lats) + pad, s: Math.min(...lats) - pad, e: Math.max(...lngs) + pad, w: Math.min(...lngs) - pad };
      for (let z = 16; z <= 18; z++) {
        const a = tileXY(box.n, box.w, z), b = tileXY(box.s, box.e, z);
        for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) {
          urls.add(SAT_URL.replace("{z}", z).replace("{y}", y).replace("{x}", x));
        }
      }
    });
    const list = [...urls];
    let done = 0;
    for (let i = 0; i < list.length; i += 6) {
      await Promise.all(list.slice(i, i + 6).map(u => fetch(u, { mode: "no-cors" }).catch(() => null)));
      done = Math.min(list.length, i + 6);
      if (progress) progress(`${done}/${list.length}`);
    }
    return list.length;
  }

  // ---------- OpenStreetMap import ----------

  // Golf holes drawn in OpenStreetMap run tee → green, tagged with the
  // hole number. Returns Map(hole -> {tee_lat, tee_lng, green_lat, green_lng}).
  async function importFromOsm(lat, lng) {
    const q = `[out:json][timeout:25];way["golf"="hole"](around:1800,${lat},${lng});out geom tags;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST", body: "data=" + encodeURIComponent(q),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!res.ok) throw new Error("OpenStreetMap didn't answer — try again in a minute.");
    const data = await res.json();
    const out = new Map();
    (data.elements || []).forEach(w => {
      const ref = parseInt((w.tags && w.tags.ref) || "", 10);
      if (!(ref >= 1 && ref <= 18) || !w.geometry || w.geometry.length < 2) return;
      const first = w.geometry[0], last = w.geometry[w.geometry.length - 1];
      // Several courses nearby can share hole numbers: keep the nearest.
      const d = metres({ lat, lng }, { lat: first.lat, lng: first.lon });
      const prev = out.get(ref);
      if (prev && prev._d <= d) return;
      out.set(ref, { tee_lat: first.lat, tee_lng: first.lon, green_lat: last.lat, green_lng: last.lon, _d: d });
    });
    out.forEach(v => delete v._d);
    return out;
  }

  async function findPlace(q) {
    const res = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=" + encodeURIComponent(q),
      { headers: { "Accept": "application/json" } });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows && rows[0] ? { lat: Number(rows[0].lat), lng: Number(rows[0].lon) } : null;
  }

  // ---------- the committee's pin editor ----------

  // opts: { el, course, geo: Map, holes:[par info], onSaveHole(hole,row), onSaveCentre(lat,lng) }
  async function pinEditor(opts) {
    const L = await loadLeaflet();
    const el = opts.el;
    el.innerHTML = `<div id="pe-map" class="pe-map"></div>`;
    const map = L.map("pe-map");
    const layers = baseLayers(L);
    layers.sat.addTo(map);
    L.control.layers({ "Satellite": layers.sat, "Map": layers.map }, null, { position: "topright" }).addTo(map);

    let centre = opts.course.lat != null ? { lat: opts.course.lat, lng: opts.course.lng } : null;
    if (!centre) {
      centre = await findPlace(opts.course.name + (opts.course.address ? ", " + opts.course.address : ""))
            || await findPlace(opts.course.name);
      if (centre && opts.onSaveCentre) opts.onSaveCentre(centre.lat, centre.lng);
    }
    map.setView(centre ? [centre.lat, centre.lng] : [51.2, -0.7], centre ? 16 : 11);

    const state = { hole: 1, mode: "tee", tee: null, green: null, line: null };

    function redraw() {
      [state.tee, state.green, state.line].forEach(m => m && map.removeLayer(m));
      state.tee = state.green = state.line = null;
      const g = opts.geo.get(state.hole) || {};
      const tee = teeOf(g), green = greenOf(g);
      if (tee) {
        state.tee = L.marker([tee.lat, tee.lng], { icon: pinIcon(L, "tee", "T"), draggable: true }).addTo(map);
        state.tee.on("dragend", () => setPoint("tee", state.tee.getLatLng()));
      }
      if (green) {
        state.green = L.marker([green.lat, green.lng], { icon: pinIcon(L, "green", "⚑"), draggable: true }).addTo(map);
        state.green.on("dragend", () => setPoint("green", state.green.getLatLng()));
      }
      if (tee && green) state.line = L.polyline([[tee.lat, tee.lng], [green.lat, green.lng]], { color: "#f2c94c", weight: 2 }).addTo(map);
      if (opts.onHoleChange) opts.onHoleChange(state.hole, g, tee && green ? yards(tee, green) : null);
    }

    function setPoint(kind, ll) {
      const g = { ...(opts.geo.get(state.hole) || {}) };
      g[kind + "_lat"] = ll.lat; g[kind + "_lng"] = ll.lng;
      opts.geo.set(state.hole, g);
      redraw();
      opts.onSaveHole(state.hole, g);
    }

    map.on("click", e => {
      const placed = state.mode;
      setPoint(placed, e.latlng);
      // Tee placed? Next tap is the green. Green placed with a tee? That
      // hole's done — the page moves on to the next one.
      if (placed === "tee") { state.mode = "green"; if (opts.onModeChange) opts.onModeChange(state.mode); }
      else if (teeOf(opts.geo.get(state.hole)) && opts.onHoleDone) opts.onHoleDone(state.hole);
    });

    redraw();
    return {
      setHole(h) {
        state.hole = h; state.mode = "tee";
        redraw();
        const g = opts.geo.get(h);
        const pts = [teeOf(g), greenOf(g)].filter(Boolean);
        if (pts.length === 2) map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])).pad(0.3), { maxZoom: 18 });
        else if (pts.length === 1) map.setView([pts[0].lat, pts[0].lng], 17);
        if (opts.onModeChange) opts.onModeChange(state.mode);
      },
      setMode(m) { state.mode = m; if (opts.onModeChange) opts.onModeChange(m); },
      centre() { const c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
      refresh: redraw,
      destroy() { map.remove(); },
    };
  }

  window.HoleMaps = { yards, metres, startGps, stopGps, onGps, toGreen, openHoleMap, pinEditor, importFromOsm, prefetch, gps };
})();
