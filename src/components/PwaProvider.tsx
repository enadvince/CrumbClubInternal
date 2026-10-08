"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Serwist } from "@serwist/window";
import { requestPersistentStorage, SW_URL, SYNC_NOW_EVENT, updateBlocker, type UpdateBlocker } from "@/lib/pwa";

type PwaState = {
  /** A new version is installed and waiting. */
  updateReady: boolean;
  /** Activates the waiting version if the cart and sync queue are empty. Returns what blocked it, if anything. */
  applyUpdate: () => Promise<UpdateBlocker>;
};

const PwaContext = createContext<PwaState>({ updateReady: false, applyUpdate: async () => null });
export const usePwa = () => useContext(PwaContext);

const UPDATE_CHECK_MS = 30 * 60 * 1000;

/**
 * Registers the service worker and handles updates without ever reloading on its own:
 * a waiting version is announced with a banner and only activated when it's safe.
 */
export function PwaProvider({ children }: { children: ReactNode }) {
  const [updateReady, setUpdateReady] = useState(false);
  const serwistRef = useRef<Serwist | null>(null);
  const applying = useRef(false);

  useEffect(() => {
    void requestPersistentStorage();
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    const sw = new Serwist(SW_URL, { scope: "/", type: "classic" });
    serwistRef.current = sw;
    sw.addEventListener("waiting", () => setUpdateReady(true));
    // Reload only after the person tapped "Update now", never because a worker took over by itself.
    sw.addEventListener("controlling", () => {
      if (applying.current) window.location.reload();
    });
    sw.register().catch((err: unknown) => console.warn("Service worker registration failed", err));

    const onMessage = (e: MessageEvent<{ type?: string }>) => {
      if (e.data?.type === "SYNC_NOW") window.dispatchEvent(new Event(SYNC_NOW_EVENT));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    const timer = setInterval(() => { void sw.update().catch(() => {}); }, UPDATE_CHECK_MS);
    return () => {
      clearInterval(timer);
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  const applyUpdate = useCallback(async (): Promise<UpdateBlocker> => {
    const blocker = await updateBlocker();
    if (blocker) return blocker;
    applying.current = true;
    serwistRef.current?.messageSkipWaiting();
    return null;
  }, []);

  return (
    <PwaContext.Provider value={{ updateReady, applyUpdate }}>
      {children}
      <UpdateBanner />
    </PwaContext.Provider>
  );
}

const BLOCKED_TEXT: Record<Exclude<UpdateBlocker, null>, string> = {
  sync: "Finish syncing orders before updating.",
  cart: "Finish or clear the current order before updating.",
};

/** Non-blocking "Update available" card. Selling carries on underneath it. */
function UpdateBanner() {
  const { updateReady, applyUpdate } = usePwa();
  const [blocked, setBlocked] = useState<UpdateBlocker>(null);
  const [hidden, setHidden] = useState(false);
  if (!updateReady || hidden) return null;

  return (
    <div role="status" className="no-print fixed right-4 bottom-4 z-40 flex max-w-sm flex-col gap-2 rounded-2xl border-2 border-ube bg-paper p-4 text-ink shadow-xl">
      <p className="font-bold">Update available</p>
      <p className="text-sm text-ink-soft">
        {blocked ? <span className="font-semibold text-warn">⚠ {BLOCKED_TEXT[blocked]}</span> : "A new version of the POS is ready. Updating reloads the page."}
      </p>
      <div className="flex gap-2">
        <button className="btn-ube min-h-11 flex-1" onClick={async () => setBlocked(await applyUpdate())}>Update now</button>
        <button className="btn-ghost min-h-11" onClick={() => setHidden(true)}>Later</button>
      </div>
    </div>
  );
}
