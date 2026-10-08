"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { Modal } from "@/components/Modal";
import { getDb } from "@/lib/offline/db";
import { formatPeso } from "@/lib/money";
import { formatTime } from "@/lib/time";

/** The current staff member's sales for this event, straight from the tablet (includes unsynced). */
export function ShiftPanel({ open, onClose, eventId, staffId, staffName }: { open: boolean; onClose: () => void; eventId: string; staffId: string; staffName: string }) {
  const sales = useLiveQuery(
    () => (open ? getDb().sales.where("eventId").equals(eventId).filter((s) => s.staffId === staffId).reverse().sortBy("createdAt") : []),
    [open, eventId, staffId],
    [],
  );
  const completed = sales.filter((s) => s.status === "completed");
  const total = completed.reduce((s, x) => s + x.total, 0);
  const cash = completed.filter((s) => s.paymentMethod === "cash").reduce((s, x) => s + x.total, 0);

  return (
    <Modal open={open} onClose={onClose} title={`${staffName}'s sales this event`} wide>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sales" value={String(completed.length)} />
        <Stat label="Total" value={formatPeso(total)} />
        <Stat label="Cash" value={formatPeso(cash)} />
        <Stat label="QR Ph" value={formatPeso(total - cash)} />
      </div>
      {sales.length === 0 ? <p className="text-ink-soft">No sales yet.</p> : (
        <ul className="divide-y divide-crust-dark">
          {sales.map((s) => (
            <li key={s.id} className={`flex flex-wrap items-center gap-3 py-2 ${s.status === "voided" ? "text-ink-soft line-through" : ""}`}>
              <span className="w-20 tabular-nums">{formatTime(s.createdAt)}</span>
              <span className="w-32 font-mono text-sm">{s.orderNumber ?? ""}</span>
              <span className="min-w-0 flex-1 truncate">{s.summary}</span>
              <span className="text-sm">{s.paymentMethod === "cash" ? "Cash" : `QR ${s.qrReference}`}</span>
              <span className="w-24 text-right font-bold tabular-nums">{formatPeso(s.total)}</span>
              <span className="w-24 text-right text-xs no-underline">
                {s.status === "voided" ? "Voided" : s.syncedAt ? "✓ Synced" : "↻ Not synced"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-cream p-3">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className="text-xl font-black tabular-nums">{value}</p>
    </div>
  );
}
