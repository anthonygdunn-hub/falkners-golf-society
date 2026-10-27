// Keeps the app opening on the course when signal is patchy.
// The shell (pages, styles, scripts) comes from the network when it can
// and from the cache when it can't. Data calls to Supabase are never
// cached — scores queue on the phone instead (see app.js).
const CACHE = "falkners-app-v2";
const SHELL = [
  "./",
  "./index.html",
  "./app.css?v=2",
  "./app.js?v=2",
  "./scoring.js?v=2",
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
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return; // live data only

  const sameOrigin = url.origin === self.location.origin;
  const cacheable = sameOrigin || url.hostname === "unpkg.com" || url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("gstatic.com");
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
