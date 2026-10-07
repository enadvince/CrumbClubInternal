"use client";
import { useEffect } from "react";

/** Keeps the screen on while the POS is open. Re-acquired when the tab becomes visible again. */
export function useWakeLock(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState === "visible" && !sentinel) {
          sentinel = await navigator.wakeLock.request("screen");
          sentinel.addEventListener("release", () => { sentinel = null; });
          if (cancelled) sentinel.release();
        }
      } catch {
        // Battery saver or permissions can refuse it; nothing else to do.
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") acquire(); };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => {});
    };
  }, [enabled]);
}
