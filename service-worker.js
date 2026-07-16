// Service Worker — Sirius Parole 3.0
const CACHE = "sirius3-v1";
const ASSETS = [
  "./", "./index.html", "./style.css",
  "./game.js", "./words.js", "./leaderboard.js",
  "./manifest.json", "./images/sirius-parole-logo.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Non cachiamo Firebase e Treccani: dati sempre freschi
  if (url.hostname.includes("firebaseio.com") || url.hostname.includes("googleapis.com") ||
      url.hostname.includes("gstatic.com") || url.hostname.includes("treccani.it")) return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((r) => {
      if (r.ok && e.request.method === "GET") {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, cp)).catch(() => {});
      }
      return r;
    }).catch(() => cached))
  );
});
