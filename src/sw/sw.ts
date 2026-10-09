/// <reference lib="webworker" />
/*
 * Crumb Club POS service worker (built by Serwist, served at /serwist/sw.js).
 *
 * Goal: the POS opens with zero network once it has been installed.
 *  - App shell: every hashed JS/CSS chunk, public icons, the manifest, /pos, /help and the
 *    offline page are precached at install. A new deploy installs a new worker that WAITS:
 *    the POS shows "Update available" and only activates it when the cart and the sync queue
 *    are empty (see UpdateBanner).
 *  - Product photos (Supabase public storage): cache-first with expiry.
 *  - Other pages: network only, with the offline page as the fallback.
 *  - Supabase REST, RPC and auth calls are never handled here, so tokens and writes never
 *    touch the HTTP cache. Sales, the menu and the sync queue live in IndexedDB instead.
 */
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Keep in step with SYNC_TAG in src/lib/pwa.ts
const SYNC_TAG = "crumbclub-sync";

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: { cleanupOutdatedCaches: true, ignoreURLParametersMatching: [/.*/] },
  // Never take over on our own: the POS decides when it is safe to update.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    {
      // Product and bundle photos from Supabase public storage
      matcher: ({ url, request }) =>
        request.destination === "image" && url.pathname.includes("/storage/v1/object/public/"),
      handler: new CacheFirst({
        cacheName: "product-photos",
        plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 })],
      }),
    },
    {
      // Same-origin pages that are not precached (owner pages, login): always live.
      matcher: ({ request, sameOrigin }) => sameOrigin && request.mode === "navigate",
      handler: new NetworkOnly(),
    },
  ],
  fallbacks: {
    entries: [{ url: "/~offline", matcher: ({ request }) => request.destination === "document" }],
  },
});

serwist.addEventListeners();

// Remove the caches left by the hand-written v1 worker (public/sw.js).
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => /^(pages|static|images)-v1$/.test(k)).map((k) => caches.delete(k))),
    ),
  );
});

/*
 * Background Sync, where the browser supports it (Huawei Browser may not). The worker
 * can't run the sync engine itself, so it asks any open POS tab to sync now. The POS
 * also syncs on its own timers, so nothing depends on this.
 */
type SyncEvent = ExtendableEvent & { tag: string };
self.addEventListener("sync", ((event: SyncEvent) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) client.postMessage({ type: "SYNC_NOW" });
    }),
  );
}) as EventListener);
