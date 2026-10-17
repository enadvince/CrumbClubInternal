"use client";
import { useEffect, useRef } from "react";

/** How often an open owner page reloads its data while it is on screen. */
export const AUTO_REFRESH_MS = 60_000;
/** Coming back to the tab within this long of the last refresh doesn't refresh again. */
const MIN_GAP_MS = 5_000;

/**
 * Keeps an owner page current without a manual reload: refreshes when the person comes back
 * to the tab or window, and every `intervalMs` while it is visible. Pass `paused` while a form
 * or dialog is open so nothing changes under someone who is editing.
 */
export function useAutoRefresh(refresh: () => unknown, { paused = false, intervalMs = AUTO_REFRESH_MS } = {}) {
  const refreshRef = useRef(refresh);
  const pausedRef = useRef(paused);
  const lastRef = useRef(Date.now());
  useEffect(() => { refreshRef.current = refresh; pausedRef.current = paused; });

  useEffect(() => {
    const run = (force: boolean) => {
      if (pausedRef.current || document.visibilityState !== "visible") return;
      if (!force && Date.now() - lastRef.current < MIN_GAP_MS) return;
      lastRef.current = Date.now();
      void refreshRef.current();
    };
    const onReturn = () => run(false);
    const timer = setInterval(() => run(true), intervalMs);
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [intervalMs]);
}
