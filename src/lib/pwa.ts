import { getDb } from "./offline/db";

/** Served by src/app/serwist/[path]/route.ts, built from src/sw/sw.ts. */
export const SW_URL = "/serwist/sw.js";
/** Background Sync tag. Keep in step with src/sw/sw.ts. */
export const SYNC_TAG = "crumbclub-sync";
/** Window event fired when something (e.g. the service worker) asks the POS to sync now. */
export const SYNC_NOW_EVENT = "crumbclub:sync-now";
/** The POS keeps the current cart here so it survives a reload. */
export const CART_KEY = "crumbclub-pos-cart";

export function cartIsEmpty(): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) ?? "null") as { cart?: unknown[] } | null;
    return !saved?.cart || saved.cart.length === 0;
  } catch {
    return true;
  }
}

/** Queue entries (orders, voids, shifts, audit) not yet confirmed by the server. */
export async function unsyncedCount(): Promise<number> {
  try {
    return await getDb().outbox.where("status").notEqual("synced").count();
  } catch {
    return 0;
  }
}

export type UpdateBlocker = "cart" | "sync" | null;

/**
 * A new app version may only take over when nothing is in flight: an empty cart
 * and an empty sync queue. Otherwise a reload mid-sale or mid-sync could confuse staff.
 */
export async function updateBlocker(): Promise<UpdateBlocker> {
  if (!cartIsEmpty()) return "cart";
  if ((await unsyncedCount()) > 0) return "sync";
  return null;
}

/** Asks the browser to keep IndexedDB under storage pressure. Logs the outcome once per load. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) {
    console.info("[storage] persistent storage API not available");
    return null;
  }
  try {
    const already = await navigator.storage.persisted();
    const granted = already || (await navigator.storage.persist());
    console.info(`[storage] persistent storage ${granted ? "granted" : "not granted"}${already ? " (already)" : ""}`);
    return granted;
  } catch (err) {
    console.warn("[storage] persist() failed", err);
    return null;
  }
}

type SyncManagerLike = { register(tag: string): Promise<void> };

/** Registers a Background Sync where supported. Best effort only; the POS never depends on it. */
export async function requestBackgroundSync(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = (await navigator.serviceWorker.getRegistration()) as (ServiceWorkerRegistration & { sync?: SyncManagerLike }) | undefined;
    await reg?.sync?.register(SYNC_TAG);
  } catch {
    // Unsupported (e.g. Huawei Browser) or denied: the POS timers cover it.
  }
}
