// Keeps the app opening on the course when signal is patchy.
// The shell (pages, styles, scripts) comes from the network when it can
// and from the cache when it can't. Data calls to Supabase are never
// cached — scores queue on the phone instead (see app.js).
const CACHE = "falkners-app-v5";
const SHELL = [
  "./",
  "./index.html",
  "./app.css?v=5",
  "./app.js?v=5",
  "./scoring.js?v=5",
  "./maps.js?v=5",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "../js/config.js",
  "https://unpkg.com/@supabase/supabase-js@2",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Map tiles keep in their own cache, served from it first, so a hole
// you've looked at (or saved for offline) shows with no signal.
const TILES = "falkners-tiles-v1";
const TILE_HOSTS = ["server.arcgisonline.com", "tile.openstreetmap.org"];
const MAX_TILES = 4000;
let puts = 0;

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return; // live data only

  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque")) { c.put(req, res.clone()); if (++puts % 200 === 0) trimTiles(); }
        return res;
      } catch (err) { return Response.error(); }
    }));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const cacheable = sameOrigin || url.hostname === "unpkg.com" || url.hostname === "cdnjs.cloudflare.com" || url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("gstatic.com");
  if (!cacheable) return;

  // Network first, cache as the fallback.
  e.respondWith(
    fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
