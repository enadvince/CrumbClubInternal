"use client";
import type { SyncState } from "@/lib/offline/sync";
import type { UnsyncedSummary } from "@/lib/offline/stock";
import { STALE_UNSYNCED_MS } from "@/lib/offline/stock";
import { timeAgo } from "@/lib/time";

export function SyncPill({ state, summary, onClick }: { state: SyncState; summary: UnsyncedSummary; onClick: () => void }) {
  const unsynced = summary.unsyncedSales;
  let tone = "bg-ok-light text-ok border-ok/40";
  let icon = "●";
  let text = "Online · all synced";
  if (!state.online) {
    tone = unsynced ? "bg-warn-light text-warn border-warn/50" : "bg-crust text-ink border-crust-dark";
    icon = "○";
    text = `Offline${unsynced ? ` · ${unsynced} unsynced` : " · nothing waiting"}`;
  } else if (summary.failed > 0) {
    tone = "bg-danger-light text-danger border-danger/40";
    icon = "✕";
    text = `${summary.failed} failed to sync`;
  } else if (state.syncing && summary.pending > 0) {
    icon = "↻";
    text = `Syncing ${unsynced}…`;
  } else if (unsynced > 0) {
    tone = "bg-warn-light text-warn border-warn/50";
    icon = "↻";
    text = `${unsynced} unsynced`;
  }
  return (
    <button onClick={onClick} className={`flex min-h-11 items-center gap-2 rounded-full border-2 px-3 text-sm font-bold ${tone}`} aria-label={`Sync status: ${text}. Open details.`}>
      <span aria-hidden>{icon}</span>
      {text}
    </button>
  );
}

export function UnsyncedBanner({ summary, now, onOpen }: { summary: UnsyncedSummary; now: number; onOpen: () => void }) {
  if (!summary.oldestUnsyncedAt || now - summary.oldestUnsyncedAt < STALE_UNSYNCED_MS) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 bg-danger px-4 py-3 font-bold text-white">
      <span aria-hidden className="text-2xl">⚠</span>
      <span className="flex-1">
        {summary.unsyncedSales} sale{summary.unsyncedSales === 1 ? " has" : "s have"} not synced since {timeAgo(summary.oldestUnsyncedAt, now)}.
        Connect the tablet to Wi-Fi or a phone hotspot. If that&apos;s not possible, an owner should download a backup.
      </span>
      <button className="btn min-h-11 bg-white text-danger" onClick={onOpen}>Sync options</button>
    </div>
  );
}
