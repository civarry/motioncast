// Offline-capable cache for the app shell. The live data path is a WebSocket
// and is never cached.
//
// Strategy: NETWORK-FIRST. We always try the network so updated code ships
// immediately, and fall back to cache only when offline. (The previous
// cache-first approach pinned phones to stale sensors.js / index.html after
// updates.) Bump CACHE to invalidate everything an old worker stored.
const CACHE = "motioncast-v9";
const SHELL = [
  "/",
  "/index.html",
  "/laptop",
  "/style.css",
  "/sensors.js",
  "/game.js",
  "/icon.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.protocol === "wss:") return;
  if (url.pathname.startsWith("/api/")) return; // dynamic (info/QR) - never cache

  // Network-first: fetch fresh, refresh the cache, fall back to cache offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200 && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
