import type { SyncState } from "./sync";
import type { UnsyncedSummary } from "./stock";

export type PillTone = "ok" | "pending" | "syncing" | "offline" | "attention";
export type PillState = { tone: PillTone; text: string; spinner: boolean };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the always-visible sync pill says. Precedence: anything rejected (red) first,
 * then offline (grey), syncing (blue), waiting (amber), all synced (green).
 */
export function pillState(state: Pick<SyncState, "online" | "syncing">, s: UnsyncedSummary): PillState {
  if (s.failed > 0) {
    const n = s.failedSales > 0 ? s.failedSales : s.failed;
    const noun = s.failedSales > 0 ? ["order needs", "orders need"] : ["item needs", "items need"];
    return { tone: "attention", text: `${plural(n, noun[0], noun[1])} attention`, spinner: false };
  }
  if (!state.online) return { tone: "offline", text: "Offline: orders saved on this device", spinner: false };
  if (state.syncing && s.pending > 0) {
    const text = s.pendingSales > 0 ? `Syncing ${plural(s.pendingSales, "order", "orders")}...` : `Syncing ${plural(s.pending, "change", "changes")}...`;
    return { tone: "syncing", text, spinner: true };
  }
  if (s.pending > 0) {
    const text = s.pendingSales > 0 ? `${plural(s.pendingSales, "order", "orders")} pending sync` : `${plural(s.pending, "change", "changes")} pending sync`;
    return { tone: "pending", text, spinner: false };
  }
  return { tone: "ok", text: "All synced", spinner: false };
}

/** Toast text for a change in connectivity, or null when nothing changed. */
export function connectionToast(wasOnline: boolean, isOnline: boolean, s: UnsyncedSummary): string | null {
  if (wasOnline && !isOnline) return "Connection lost. Keep selling: orders are saved on this device.";
  if (!wasOnline && isOnline) {
    const waiting = s.pendingSales + s.failedSales;
    return waiting > 0 ? `Back online, syncing ${plural(waiting, "order", "orders")}` : "Back online";
  }
  return null;
}
