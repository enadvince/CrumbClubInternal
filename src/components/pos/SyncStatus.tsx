"use client";
import { useEffect, useRef, useState } from "react";
import type { SyncState } from "@/lib/offline/sync";
import type { UnsyncedSummary } from "@/lib/offline/stock";
import { STALE_UNSYNCED_MS } from "@/lib/offline/stock";
import { connectionToast, pillState, type PillTone } from "@/lib/offline/syncStatus";
import type { OutboxOp } from "@/lib/offline/db";
import type { SalePayload } from "@/lib/pos/types";
import { formatPeso } from "@/lib/money";
import { formatDateTime, formatTime, timeAgo } from "@/lib/time";
import { Modal } from "@/components/Modal";
import { CopyButton } from "@/components/CopyButton";

const TONE_CLASS: Record<PillTone, string> = {
  ok: "bg-ok-light text-ok border-ok/40",
  pending: "bg-warn-light text-warn border-warn/50",
  syncing: "bg-info-light text-info border-info/40",
  offline: "bg-mute-light text-mute border-mute/40",
  attention: "bg-danger-light text-danger border-danger/40",
};
const TONE_ICON: Record<PillTone, string> = { ok: "●", pending: "↻", syncing: "", offline: "○", attention: "✕" };

/** Always-visible sync status in the sticky header. Tap to open the sync panel. */
export function SyncPill({ state, summary, onClick }: { state: SyncState; summary: UnsyncedSummary; onClick: () => void }) {
  const pill = pillState(state, summary);
  return (
    <button
      onClick={onClick}
      data-testid="sync-pill"
      data-tone={pill.tone}
      className={`flex min-h-11 items-center gap-2 rounded-full border-2 px-3 text-sm font-bold hover:brightness-95 active:brightness-90 ${TONE_CLASS[pill.tone]}`}
      aria-label={`Sync status: ${pill.text}. Open the sync panel.`}
    >
      {pill.spinner
        ? <span aria-hidden className="h-4 w-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" />
        : <span aria-hidden>{TONE_ICON[pill.tone]}</span>}
      <span aria-live="polite">{pill.text}</span>
    </button>
  );
}

export function UnsyncedBanner({ summary, now, onOpen }: { summary: UnsyncedSummary; now: number; onOpen: () => void }) {
  if (!summary.oldestUnsyncedAt || now - summary.oldestUnsyncedAt < STALE_UNSYNCED_MS) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 bg-danger px-4 py-3 font-bold text-white">
      <span aria-hidden className="text-2xl">⚠</span>
      <span className="flex-1">
        {summary.unsyncedSales} order{summary.unsyncedSales === 1 ? " has" : "s have"} not synced since {timeAgo(summary.oldestUnsyncedAt, now)}.
        Connect the tablet to Wi-Fi or a phone hotspot. If that&apos;s not possible, an owner should download an emergency export.
      </span>
      <button className="btn min-h-11 bg-white font-bold text-[#a3221b] hover:bg-[#fde6e4] active:bg-[#f9cfcb]" onClick={onOpen}>Sync panel</button>
    </div>
  );
}

const TYPE_LABEL: Record<OutboxOp["type"], string> = {
  sale: "Order", void: "Void", void_order: "Void", adjust: "Stock change", availability: "Availability", pin_use: "PIN log",
  refund: "Refund", audit: "Audit entry", shift_open: "Shift opened", shift_close: "Shift closed",
  drawer: "Drawer movement", qr_photo: "Payment photo",
};

function statusText(op: OutboxOp, now: number): string {
  if (op.status === "failed") return "Needs attention";
  if (op.status === "syncing") return "Syncing...";
  if (op.nextRetryAt && op.nextRetryAt > now) return `Retrying in ${Math.ceil((op.nextRetryAt - now) / 1000)}s`;
  return "Waiting";
}

/**
 * Every queue entry that isn't on the server yet: order number, total, time, attempts,
 * last error, with Retry now per entry and Retry all. QR payments are flagged as
 * awaiting verification.
 */
export function SyncPanel({
  open, onClose, state, summary, ops, now, menuSyncedAt, onRetry, onRetryAll, onOwner,
}: {
  open: boolean;
  onClose: () => void;
  state: SyncState;
  summary: UnsyncedSummary;
  ops: readonly OutboxOp[];
  now: number;
  menuSyncedAt: number | null;
  onRetry: (seq: number) => void;
  onRetryAll: () => void;
  onOwner: () => void;
}) {
  const waiting = ops.filter((o) => o.status !== "synced").sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const pill = pillState(state, summary);
  return (
    <Modal open={open} onClose={onClose} title="Sync" wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`badge px-3 py-1 text-sm ${TONE_CLASS[pill.tone]}`}>{pill.text}</span>
          <span className="text-sm text-ink-soft">Last successful sync: {state.lastSyncAt ? timeAgo(state.lastSyncAt, now) : "not yet"}</span>
          <span className="text-sm text-ink-soft">Menu last synced: {menuSyncedAt ? formatDateTime(menuSyncedAt) : "never"}</span>
        </div>
        {state.clockOffsetMs !== null && Math.abs(state.clockOffsetMs) > 5 * 60_000 && (
          <p role="alert" className="rounded-xl bg-warn-light p-3 text-sm font-semibold text-warn">
            ⚠ This tablet&apos;s clock is off by about {Math.round(Math.abs(state.clockOffsetMs) / 60_000)} minutes. Orders still sync; the server keeps the right time.
          </p>
        )}
        <p className="text-sm text-ink-soft">Orders are always saved on this tablet first, so you can keep selling offline.</p>

        {waiting.length === 0 ? (
          <p className="rounded-xl bg-ok-light p-3 font-semibold text-ok">✓ Everything on this tablet is on the server.</p>
        ) : (
          <ul className="divide-y divide-crust-dark rounded-xl border border-crust-dark" aria-label="Waiting to sync">
            {waiting.map((op) => {
              const qr = op.type === "sale" && (op.payload as SalePayload).payment_method === "qr_ph";
              return (
                <li key={op.seq} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3" data-testid="sync-item">
                  <div className="min-w-44 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {op.display?.orderNumber ? <span className="font-mono">{op.display.orderNumber}</span> : TYPE_LABEL[op.type]}
                      {op.display?.orderNumber && <CopyButton value={op.display.orderNumber} />}
                      {op.type !== "sale" && op.display?.orderNumber && <span className="badge bg-crust text-ink">{TYPE_LABEL[op.type]}</span>}
                      {qr && <span className="badge bg-ube-light text-ube">QR awaiting verification</span>}
                    </p>
                    <p className="text-xs text-ink-soft">
                      {formatTime(op.createdAt)} · {op.attempts} attempt{op.attempts === 1 ? "" : "s"}
                      {op.display?.label ? ` · ${op.display.label}` : ""}
                    </p>
                    {op.lastError && <p className={`text-xs ${op.status === "failed" ? "font-semibold text-danger" : "text-ink-soft"}`}>Last error: {op.lastError}</p>}
                  </div>
                  {op.display?.amount !== undefined && <span className="w-24 text-right font-bold tabular-nums">{formatPeso(op.display.amount)}</span>}
                  <span className={`w-32 text-sm ${op.status === "failed" ? "font-bold text-danger" : "text-ink-soft"}`}>{statusText(op, now)}</span>
                  <button className="btn-secondary min-h-11 text-sm" onClick={() => onRetry(op.seq!)} disabled={op.status === "syncing"}>Retry now</button>
                </li>
              );
            })}
          </ul>
        )}

        {summary.failed > 0 && (
          <p className="text-sm text-danger">
            Items that need attention were rejected by the server and won&apos;t retry on their own. Check the error, then use Retry now.
            If it keeps failing, an owner can download an emergency export from the owner menu.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={onRetryAll} disabled={state.syncing}>{state.syncing ? "Syncing..." : "↻ Retry all"}</button>
          <button className="btn-secondary" onClick={onOwner}>Owner options</button>
        </div>
      </div>
    </Modal>
  );
}

/** Dismissible toast when the connection drops or comes back. */
export function ConnectionToast({ online, summary }: { online: boolean; summary: UnsyncedSummary }) {
  const prev = useRef(online);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const text = connectionToast(prev.current, online, summary);
    prev.current = online;
    if (!text) return;
    setMessage(text);
    const t = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(t);
    // Only react to connectivity changes; the count is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  if (!message) return null;
  return (
    <div role="status" aria-live="polite" className={`no-print fixed top-20 left-1/2 z-30 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-2xl px-4 py-3 font-semibold shadow-xl ${online ? "bg-ok text-white" : "bg-ink text-paper"}`}>
      <span aria-hidden>{online ? "●" : "○"}</span>
      <span className="flex-1">{message}</span>
      <button className="min-h-11 min-w-11 rounded-lg hover:bg-white/15 active:bg-white/25" onClick={() => setMessage(null)} aria-label="Dismiss">✕</button>
    </div>
  );
}
