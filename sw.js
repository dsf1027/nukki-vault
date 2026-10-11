// Offline support. The app shell is network-first (so updates show up),
// the large wasm/model files are cache-first (fetched once, then offline).
const CACHE = "nukki-vault-v2";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "segment.js", "physics.js", "store.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-180.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function remember(req, res) {
  if (res.ok && res.status === 200) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

// The segmentation model lives on Google's bucket; cache it so the app works offline.
const MODEL_PREFIX = "https://storage.googleapis.com/mediapipe-models/";

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === "GET" && req.url.startsWith(MODEL_PREFIX)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => remember(req, r))));
    return;
  }
  if (req.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname.includes("/vendor/")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => remember(req, r))));
    return;
  }
  e.respondWith(
    fetch(req)
      .then((r) => remember(req, r))
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          // Only page loads may fall back to the app shell; other requests must fail honestly.
          return req.mode === "navigate" ? caches.match("index.html") : Response.error();
        })
      )
  );
});
