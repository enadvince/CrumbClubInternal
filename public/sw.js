/*
 * Crumb Club POS service worker.
 * Goal: the POS (/pos) must open with no network at all once it has loaded online once.
 *  - /pos pages: served from cache immediately, refreshed in the background.
 *  - /_next/static/*: cache-first (file names are content-hashed).
 *  - Product photos (Supabase public storage): cache-first so cards keep their pictures offline.
 *  - Everything else (owner pages, API, Supabase RPCs): network, with a cached copy as a fallback for pages.
 * Sales data never goes through here; it lives in IndexedDB.
 */
const VERSION = "v1";
const PAGES = `pages-${VERSION}`;
const STATIC = `static-${VERSION}`;
const IMAGES = `images-${VERSION}`;
const PRECACHE = ["/pos", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PAGES).then((cache) =>
      Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {}))),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![PAGES, STATIC, IMAGES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isPosPage(url) {
  return url.pathname === "/pos" || url.pathname.startsWith("/pos/");
}

async function staleWhileRevalidate(request, cacheName, key) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key ?? request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(key ?? request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached ?? (await network) ?? offlineResponse();
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === "opaque") cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(PAGES);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic" && !response.redirected) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) ?? offlineResponse();
  }
}

function offlineResponse() {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Offline</title>
     <body style="font-family:system-ui;background:#fff8ef;color:#24160c;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:16px">
     <div><h1>You're offline</h1><p>This page needs the internet. The POS works offline: <a href="/pos">open the POS</a>.</p></div>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Product photos from Supabase public storage
  if (url.origin !== self.location.origin) {
    if (request.destination === "image" && url.pathname.includes("/storage/v1/object/public/")) {
      event.respondWith(cacheFirst(request, IMAGES).catch(() => Response.error()));
    }
    return;
  }

  // React Server Component payloads and API routes: always live.
  if (url.pathname.startsWith("/api/") || url.searchParams.has("_rsc") || request.headers.get("RSC") === "1") return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC));
    return;
  }

  if (request.mode === "navigate") {
    if (isPosPage(url)) event.respondWith(staleWhileRevalidate(request, PAGES, url.pathname));
    else event.respondWith(networkFirst(request));
    return;
  }

  if (["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"].includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, PAGES));
  }
});
