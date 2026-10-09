/*
 * Retired. The POS now uses the Serwist worker at /serwist/sw.js. Tablets that still
 * have this v1 worker pick up this file on their next update check: it stops serving
 * from the old caches, and the page then registers the new worker for the same scope.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => /^(pages|static|images)-v1$/.test(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
