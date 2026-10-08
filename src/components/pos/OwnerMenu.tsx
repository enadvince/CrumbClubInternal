"use client";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Modal } from "@/components/Modal";
import { ConfirmModal } from "@/components/ConfirmModal";
import { getDb, KV, type DeviceInfo } from "@/lib/offline/db";
import { CopyButton } from "@/components/CopyButton";
import { adjustStockLocally, auditLocally, setAvailabilityLocally, type AdjustmentReason } from "@/lib/offline/actions";
import { backupCsv, backupJson } from "@/lib/offline/backup";
import type { SyncEngine, SyncState } from "@/lib/offline/sync";
import type { UnsyncedSummary } from "@/lib/offline/stock";
import { downloadText } from "@/lib/csv";
import { formatPeso } from "@/lib/money";
import type { Menu } from "@/lib/pos/types";
import { formatDateTime, timeAgo } from "@/lib/time";

type Tab = "sync" | "stock" | "shifts" | "tablet";

export function OwnerMenu({
  open, onClose, engine, state, summary, menu, ownerStaffId, onUnpair, onOwnerView, onViewShift,
}: {
  open: boolean;
  onClose: () => void;
  engine: SyncEngine | null;
  state: SyncState;
  summary: UnsyncedSummary;
  menu: Menu | null;
  ownerStaffId: string;
  onUnpair: () => Promise<void>;
  /** Switches the tablet to the owner pages (dashboard). Absent in demo mode. */
  onOwnerView?: () => void;
  /** Opens a shift report full screen */
  onViewShift: (shiftId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("sync");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const unsynced = useLiveQuery(() => getDb().outbox.where("status").notEqual("synced").toArray(), [], []);
  const hasUnsynced = summary.pending + summary.failed > 0;

  async function download(kind: "json" | "csv") {
    const db = getDb();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    if (kind === "json") downloadText(`crumbclub-emergency-export-${stamp}.json`, await backupJson(db), "application/json");
    else downloadText(`crumbclub-emergency-export-${stamp}.csv`, await backupCsv(db));
    await auditLocally(db, { action: "emergency_export", manager_staff_id: ownerStaffId, note: kind });
    setMessage("Emergency export downloaded. Keep the file safe until these orders show up on the owner pages.");
  }

  async function syncNow() {
    setMessage(null);
    const r = await engine?.syncOnce();
    setMessage(r?.ok ? `Synced${r.pushed ? ` ${r.pushed} item(s)` : ""}.` : `Couldn't sync: ${r?.error ?? "offline"}`);
  }

  async function retryFailed() {
    await getDb().outbox.where("status").equals("failed").modify({ status: "pending" });
    await syncNow();
  }

  return (
    <Modal open={open} onClose={onClose} title="Owner menu" wide>
      {onOwnerView && (
        <button className="btn-primary mb-4 w-full" onClick={onOwnerView} disabled={!state.online}>
          📊 Go to owner dashboard{state.online ? "" : " (needs the internet)"}
        </button>
      )}
      <div className="mb-4 flex gap-2" role="tablist">
        {([["sync", "Sync & backup"], ["stock", "Stock"], ["shifts", "Shifts"], ["tablet", "Tablet"]] as const).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setMessage(null); }}
            className={`btn flex-1 border-2 ${tab === t ? "border-caramel bg-crust" : "border-crust-dark bg-paper"}`}>{label}</button>
        ))}
      </div>
      {message && <p role="status" className="mb-3 rounded-xl bg-cream p-3 font-semibold">{message}</p>}

      {tab === "sync" && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Item label="Connection" value={state.online ? "● Online" : "○ Offline"} />
            <Item label="Unsynced sales" value={String(summary.unsyncedSales)} />
            <Item label="Failed" value={String(summary.failed)} />
            <Item label="Last sync" value={state.lastSyncAt ? timeAgo(state.lastSyncAt) : "Never"} />
          </dl>
          {state.lastError && <p className="text-sm text-danger">Last error: {state.lastError}</p>}
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={syncNow} disabled={state.syncing}>{state.syncing ? "Syncing…" : "↻ Sync now"}</button>
            {summary.failed > 0 && <button className="btn-secondary" onClick={retryFailed}>Retry failed</button>}
          </div>
          <div className="rounded-xl border-2 border-danger/50 bg-danger-light/40 p-3">
            <p className="font-bold text-danger">Emergency export (last resort)</p>
            <p className="mb-2 text-sm text-ink-soft">
              Downloads everything stored on this tablet, including orders, refunds, shifts and drawer movements that never synced.
              Use it only if this tablet can never get online again, then contact support. Normal backups happen on the server every night.
            </p>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={() => download("json")}>⬇ Emergency export (JSON)</button>
              <button className="btn-secondary" onClick={() => download("csv")}>⬇ Emergency export (CSV)</button>
            </div>
          </div>
          {unsynced.length > 0 && (
            <div>
              <p className="mb-1 font-bold">Waiting to sync</p>
              <ul className="max-h-60 divide-y divide-crust-dark overflow-y-auto rounded-xl border border-crust-dark text-sm">
                {unsynced.map((op) => (
                  <li key={op.seq} className="flex flex-wrap gap-2 p-2">
                    <span className="w-28">{formatDateTime(op.createdAt)}</span>
                    <span className="w-20 font-semibold capitalize">{op.type}</span>
                    <span className={op.status === "failed" ? "font-semibold text-danger" : "text-ink-soft"}>
                      {op.status === "failed" ? `✕ ${op.lastError}` : op.attempts ? `retrying (${op.lastError ?? "…"})` : "pending"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === "stock" && (menu ? <StockTab menu={menu} ownerStaffId={ownerStaffId} onDone={(m) => { setMessage(m); engine?.requestSync(); }} /> : <p>No live event.</p>)}

      {tab === "shifts" && <ShiftsTab onView={onViewShift} />}

      {tab === "tablet" && (
        <div className="space-y-4">
          <TabletCode />
          <p className="text-ink-soft">Unpairing signs this tablet out and clears its local data. You&apos;ll need an owner login to set it up again.</p>
          {hasUnsynced && (
            <p role="alert" className="rounded-xl bg-danger-light p-3 font-semibold text-danger">
              ✕ Blocked: {summary.pending + summary.failed} item(s) haven&apos;t synced. Sync first, or download a backup and ask for help.
            </p>
          )}
          <button className="btn-danger" onClick={() => setConfirmUnpair(true)}>
            Unpair tablet and sign out
          </button>
          <ConfirmModal
            open={confirmUnpair}
            title="Reset this tablet?"
            confirmLabel="Unpair and clear data"
            onClose={() => setConfirmUnpair(false)}
            onConfirm={async () => { setConfirmUnpair(false); await onUnpair(); }}
            blockedReason={hasUnsynced
              ? `${summary.pending + summary.failed} item(s) are only on this tablet. Resetting now would lose them. Sync first, or download an emergency export and ask for help.`
              : undefined}
          >
            <p>This signs the tablet out and deletes its local data, including its order counter. You&apos;ll need an owner login to set it up again.</p>
          </ConfirmModal>
        </div>
      )}
    </Modal>
  );
}

/** This tablet's device code (starts every order number), with a copy button. */
function TabletCode() {
  const device = useLiveQuery(() => getDb().getKv<DeviceInfo>(KV.device), []);
  if (!device?.deviceCode) return <p className="text-ink-soft">This tablet has no device code yet.</p>;
  return (
    <p className="flex flex-wrap items-center gap-2">
      This tablet is <strong className="font-mono text-lg">{device.deviceCode}</strong>{device.label ? ` (${device.label})` : ""}.
      <CopyButton value={device.deviceCode} label="Copy code" />
    </p>
  );
}

/** Shifts on this tablet, newest first, each with its report. */
function ShiftsTab({ onView }: { onView: (shiftId: string) => void }) {
  const shifts = useLiveQuery(() => getDb().shifts.orderBy("openedAt").reverse().limit(30).toArray(), [], []);
  if (shifts.length === 0) return <p className="text-ink-soft">No shifts on this tablet yet.</p>;
  return (
    <ul className="divide-y divide-crust-dark rounded-xl border border-crust-dark">
      {shifts.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-3 p-3">
          <span className="min-w-40 flex-1">
            <span className="font-semibold">{formatDateTime(s.openedAt)}</span>
            <span className="block text-xs text-ink-soft">{s.openedByName}{s.closedAt ? ` · closed ${formatDateTime(s.closedAt)}` : " · open"}</span>
          </span>
          {s.variance != null && <span className={`badge ${s.variance === 0 ? "bg-ok-light text-ok" : "bg-warn-light text-warn"}`}>Variance {formatPeso(s.variance, { sign: true })}</span>}
          <button className="btn-secondary min-h-11 text-sm" onClick={() => onView(s.id)}>View report</button>
        </li>
      ))}
    </ul>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-cream p-2">
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="font-bold">{value}</dd>
    </div>
  );
}

function StockTab({ menu, ownerStaffId, onDone }: { menu: Menu; ownerStaffId: string; onDone: (msg: string) => void }) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const products = [...menu.products.values()].sort((a, b) => a.sort_order - b.sort_order);

  async function adjust(epId: string, name: string, reason: AdjustmentReason, sign: 1 | -1) {
    const n = qty[epId] ?? 0;
    if (n <= 0) return;
    await adjustStockLocally(getDb(), { eventId: menu.eventId, eventProductId: epId, quantityChange: sign * n, reason, staffId: ownerStaffId });
    setQty((q) => ({ ...q, [epId]: 0 }));
    onDone(`${reason === "restock" ? "Restocked" : "Removed"} ${n} ${name}.`);
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-soft">Changes apply on this tablet immediately and sync in the background.</p>
      <ul className="divide-y divide-crust-dark rounded-xl border border-crust-dark">
        {products.map((p) => (
          <li key={p.event_product_id} className="flex flex-wrap items-center gap-2 p-2">
            <span className="min-w-40 flex-1 font-semibold">{p.name}</span>
            <span className="w-20 text-sm">Stock <strong>{p.stock}</strong></span>
            <input
              type="number" min={0} aria-label={`Quantity for ${p.name}`} className="input w-20"
              value={qty[p.event_product_id] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [p.event_product_id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))}
            />
            <button className="btn-secondary min-h-11 text-sm" onClick={() => adjust(p.event_product_id, p.name, "restock", 1)}>+ Restock</button>
            <button className="btn-secondary min-h-11 text-sm" onClick={() => adjust(p.event_product_id, p.name, "waste", -1)}>− Waste</button>
            <button
              className={`badge min-h-11 px-3 ${p.is_available ? "bg-ok-light text-ok" : "bg-danger-light text-danger"}`}
              onClick={async () => {
                await setAvailabilityLocally(getDb(), menu.eventId, p.event_product_id, !p.is_available);
                onDone(`${p.name} marked ${p.is_available ? "unavailable" : "available"}.`);
              }}
            >
              {p.is_available ? "✓ Available" : "✕ Unavailable"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
