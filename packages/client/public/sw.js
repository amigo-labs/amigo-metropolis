// Service worker for offline solo play (PLAN Phase 7). Solo is a fully
// client-side deterministic sim, so once the shell + JS chunk are cached the
// game runs with no network at all. Dependency-free, hand-rolled — no
// vite-plugin-pwa — to match the repo's zero-runtime-deps ethos.
//
// Strategy:
//   - navigations: network-first, falling back to the cached app shell offline
//     (so any ?warden=… / ?online=… deep link still opens the game offline);
//   - same-origin GETs (JS, icons, manifest): stale-while-revalidate;
//   - everything else (cross-origin, the relay WebSocket): untouched.
//
// Bump CACHE to invalidate old assets; activate() drops every other cache.

const CACHE = "district-breach-v1";
const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // never touch the relay / CDNs

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) || (await cache.match("/")) || Response.error();
      }),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res?.ok && res.type === "basic") cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
