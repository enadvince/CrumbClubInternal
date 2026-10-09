"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Modal } from "@/components/Modal";
import { CopyButton } from "@/components/CopyButton";
import { ScrollProgress, BackToTop } from "@/components/ScrollAids";
import { getDb, type LocalSale } from "@/lib/offline/db";
import {
  ActionError, logPinUseLocally, refundLocally, VOID_REASONS, voidOrderLocally,
} from "@/lib/offline/actions";
import { refundAmount, refundableLines } from "@/lib/pos/refund";
import { shortOrderNumber } from "@/lib/offline/numbering";
import { formatPeso } from "@/lib/money";
import { formatTime } from "@/lib/time";
import { getSupabase } from "@/lib/supabase/client";
import { isPosDemo } from "@/lib/offline/demoTransport";
import type { SnapshotStaff } from "@/lib/pos/types";
import { OwnerPinGate } from "./OwnerPinGate";

type ServerOrder = {
  id: string; order_number: string; total_centavos: number; status: "completed" | "voided"; client_created_at: string;
  payment_method: "cash" | "qr_ph"; payment_status: string; refunded_centavos: number;
};
type Row = { id: string; orderNumber: string; total: number; status: "completed" | "voided"; createdAt: string;
  paymentMethod: "cash" | "qr_ph"; awaiting: boolean; refunded: number; summary: string; local: LocalSale | null; synced: boolean };

/** Matches a full or partial order number, or the short "042" form staff call out. */
export function matchesOrderSearch(orderNumber: string, query: string): boolean {
  const q = query.trim().toUpperCase().replace(/^#/, "");
  if (!q) return true;
  return orderNumber.toUpperCase().includes(q) || shortOrderNumber(orderNumber) === q.padStart(3, "0");
}

/**
 * Order history for this event: every order made on this tablet (from IndexedDB, so
 * offline orders show at once) merged with the server's list when online. Search by
 * number; void, refund or void items with an owner PIN.
 */
export function OrderHistory({
  open, onClose, eventId, staff, cashierId, shiftId, online, onChanged,
}: {
  open: boolean;
  onClose: () => void;
  eventId: string;
  staff: SnapshotStaff[];
  cashierId: string;
  shiftId: string | null;
  online: boolean;
  onChanged: (message: string) => void;
}) {
  const db = getDb();
  const [query, setQuery] = useState("");
  const [server, setServer] = useState<ServerOrder[]>([]);
  const [action, setAction] = useState<{ mode: Mode; sale: LocalSale } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const local = useLiveQuery(() => (open ? db.sales.where("eventId").equals(eventId).toArray() : []), [open, eventId], []);

  useEffect(() => {
    if (!open || !online || isPosDemo()) return;
    getSupabase().from("transactions")
      .select("id, order_number, total_centavos, status, client_created_at, payment_method, payment_status, refunded_centavos")
      .eq("event_id", eventId).order("client_created_at", { ascending: false }).limit(300)
      .then(({ data }) => setServer((data as ServerOrder[]) ?? []));
  }, [open, online, eventId]);

  const rows = useMemo(() => {
    const byId = new Map<string, Row>();
    for (const o of server) {
      byId.set(o.id, {
        id: o.id, orderNumber: o.order_number, total: o.total_centavos, status: o.status, createdAt: o.client_created_at,
        paymentMethod: o.payment_method, awaiting: o.payment_status === "awaiting_verification", refunded: o.refunded_centavos,
        summary: "From another tablet or the owner pages", local: null, synced: true,
      });
    }
    // This tablet's copy wins: it includes changes not synced yet.
    for (const s of local) {
      byId.set(s.id, {
        id: s.id, orderNumber: s.orderNumber ?? "(no number)", total: s.total, status: s.status, createdAt: s.createdAt,
        paymentMethod: s.paymentMethod, awaiting: s.paymentMethod === "qr_ph" && s.paymentStatus !== "verified",
        refunded: s.refunded ?? 0, summary: s.summary, local: s, synced: !!s.syncedAt,
      });
    }
    return [...byId.values()]
      .filter((r) => matchesOrderSearch(r.orderNumber, query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [server, local, query]);

  return (
    <>
    <Modal open={open} onClose={onClose} title="Orders" wide>
      <div className="space-y-3">
        <label className="block">
          <span className="label">Search by order number</span>
          <input
            className="input" type="search" inputMode="text" placeholder="e.g. 042 or T1-261008-0042"
            value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search orders by number"
          />
        </label>
        <div ref={scrollRef} className="relative max-h-[60dvh] overflow-y-auto rounded-xl border border-crust-dark">
          <ScrollProgress target={scrollRef} />
          {rows.length === 0 ? <p className="p-4 text-ink-soft">{query ? "No order matches that number." : "No orders yet."}</p> : (
            <ul className="divide-y divide-crust-dark">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3" data-testid="order-row">
                  <span className={`flex items-center gap-1 font-mono font-semibold ${r.status === "voided" ? "text-ink-soft line-through" : ""}`}>
                    {r.orderNumber}
                  </span>
                  <CopyButton value={r.orderNumber} />
                  <span className="w-16 text-sm tabular-nums">{formatTime(r.createdAt)}</span>
                  <span className={`min-w-0 flex-1 truncate text-sm ${r.status === "voided" ? "line-through" : ""}`}>{r.summary}</span>
                  <span className="flex flex-wrap gap-1">
                    {r.status === "voided" && <span className="badge bg-danger-light text-danger">Voided</span>}
                    {r.refunded > 0 && <span className="badge bg-warn-light text-warn">Refunded {formatPeso(r.refunded)}</span>}
                    {r.awaiting && r.status !== "voided" && <span className="badge bg-ube-light text-ube">QR awaiting verification</span>}
                    {!r.synced && <span className="badge bg-mute-light text-mute">Not synced</span>}
                  </span>
                  <span className={`w-24 text-right font-bold tabular-nums ${r.status === "voided" ? "text-ink-soft line-through" : ""}`}>{formatPeso(r.total)}</span>
                  {r.local && r.status === "completed" && (
                    <span className="flex w-full flex-wrap justify-end gap-2">
                      {r.refunded === 0 && <button className="btn-secondary min-h-11 text-sm" onClick={() => setAction({ mode: "void", sale: r.local! })}>Void order</button>}
                      <button className="btn-secondary min-h-11 text-sm" onClick={() => setAction({ mode: "line_void", sale: r.local! })}>Void item</button>
                      <button className="btn-secondary min-h-11 text-sm" onClick={() => setAction({ mode: "refund", sale: r.local! })}>Refund</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <BackToTop target={scrollRef} />
        </div>
        <p className="text-xs text-ink-soft">Orders from another tablet can be voided or refunded on that tablet, or voided from the owner pages.</p>
      </div>
    </Modal>
      {action && (
        <OrderActionDialog
          mode={action.mode} sale={action.sale} staff={staff} cashierId={cashierId} shiftId={shiftId} eventId={eventId}
          onClose={() => setAction(null)}
          onDone={(message) => { setAction(null); onChanged(message); }}
        />
      )}
    </>
  );
}

type Mode = "void" | "refund" | "line_void";
const TITLES: Record<Mode, string> = { void: "Void order", refund: "Refund", line_void: "Void item" };

/** Pick the reason (and items and method for refunds), then an owner PIN approves it. */
function OrderActionDialog({
  mode, sale, staff, cashierId, shiftId, eventId, onClose, onDone,
}: {
  mode: Mode; sale: LocalSale; staff: SnapshotStaff[]; cashierId: string; shiftId: string | null; eventId: string;
  onClose: () => void; onDone: (message: string) => void;
}) {
  const db = getDb();
  const [step, setStep] = useState<"form" | "pin">("form");
  const [reason, setReason] = useState<(typeof VOID_REASONS)[number]["code"] | null>(null);
  const [note, setNote] = useState("");
  const [method, setMethod] = useState<"cash" | "qr_ph">(sale.paymentMethod);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const lines = refundableLines(sale.payload.lines, sale.refundedLines);

  const amount = mode === "void" ? sale.total : lines.reduce(
    (s, l) => s + refundAmount(l.net, l.soldQty, l.refundedQty, l.refundedAmount, qty[l.lineId] ?? 0), 0);
  const effectiveMethod = mode === "refund" ? method : sale.paymentMethod;
  const canContinue = !!reason && (reason !== "other" || note.trim().length > 0) && (mode === "void" || amount > 0);
  const summary = mode === "void"
    ? `Void order ${sale.orderNumber} (${formatPeso(sale.total)}). Return the customer's payment.`
    : `${mode === "refund" ? "Refund" : "Void items for"} ${formatPeso(amount)} ${effectiveMethod === "cash" ? "in cash" : "by QR"} on order ${sale.orderNumber}.`;

  async function approve(owner: SnapshotStaff) {
    setError(null);
    try {
      if (mode === "void") {
        await voidOrderLocally(db, { saleId: sale.id, reasonCode: reason!, note, cashierId, approverId: owner.id, shiftId });
      } else {
        await refundLocally(db, {
          saleId: sale.id, kind: mode, method: effectiveMethod, reasonCode: reason!, note, cashierId, approverId: owner.id, shiftId,
          lines: Object.entries(qty).filter(([, q]) => q > 0).map(([lineId, quantity]) => ({ lineId, quantity })),
        });
      }
      await logPinUseLocally(db, owner.id, "void_approval", eventId);
      onDone(mode === "void" ? `Order ${sale.orderNumber} voided. Stock returned.` : `${formatPeso(amount)} ${mode === "refund" ? "refunded" : "voided"} on ${sale.orderNumber}.`);
    } catch (e) {
      setError(e instanceof ActionError || e instanceof Error ? e.message : "Couldn't save that");
      setStep("form");
    }
  }

  return (
    <Modal open onClose={onClose} title={`${TITLES[mode]} · ${sale.orderNumber ?? ""}`} wide>
      {step === "pin" ? (
        <OwnerPinGate staff={staff} eventId={eventId} title="Owner PIN to approve" subtitle={summary} onApproved={(o) => void approve(o)} onCancel={() => setStep("form")} />
      ) : (
        <div className="space-y-4">
          {error && <p role="alert" className="font-semibold text-danger">✕ {error}</p>}
          {mode !== "void" && (
            <fieldset className="space-y-2">
              <legend className="label">Items</legend>
              {lines.map((l) => (
                <div key={l.lineId} className="flex flex-wrap items-center gap-3 rounded-xl border border-crust-dark p-2">
                  <span className="min-w-40 flex-1 font-semibold">{l.name}</span>
                  <span className="text-sm text-ink-soft">{l.remainingQty} of {l.soldQty} left</span>
                  <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${l.name}`}>
                    <button className="btn-secondary h-11 w-11 p-0" disabled={(qty[l.lineId] ?? 0) <= 0} onClick={() => setQty((q) => ({ ...q, [l.lineId]: (q[l.lineId] ?? 0) - 1 }))} aria-label={`One fewer ${l.name}`}>−</button>
                    <span className="w-8 text-center font-bold tabular-nums">{qty[l.lineId] ?? 0}</span>
                    <button className="btn-secondary h-11 w-11 p-0" disabled={(qty[l.lineId] ?? 0) >= l.remainingQty} onClick={() => setQty((q) => ({ ...q, [l.lineId]: (q[l.lineId] ?? 0) + 1 }))} aria-label={`One more ${l.name}`}>+</button>
                  </div>
                </div>
              ))}
            </fieldset>
          )}
          {mode === "refund" && (
            <fieldset>
              <legend className="label">Refund method</legend>
              <div className="grid grid-cols-2 gap-2" role="radiogroup">
                {([["cash", "💵 Cash"], ["qr_ph", "📱 QR"]] as const).map(([m, label]) => (
                  <button key={m} role="radio" aria-checked={method === m} onClick={() => setMethod(m)}
                    className={`btn border-2 ${method === m ? "border-caramel bg-caramel text-white hover:bg-caramel-dark" : "border-crust-dark bg-paper text-ink hover:bg-crust"}`}>{label}</button>
                ))}
              </div>
              {method === "cash" && <p className="mt-1 text-xs text-ink-soft">Cash refunds reduce the cash expected in the drawer.</p>}
            </fieldset>
          )}
          <fieldset>
            <legend className="label">Reason</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup">
              {VOID_REASONS.map((r) => (
                <button key={r.code} role="radio" aria-checked={reason === r.code} onClick={() => setReason(r.code)}
                  className={`btn border-2 text-sm ${reason === r.code ? "border-ink bg-ink text-paper hover:bg-ink-soft" : "border-crust-dark bg-paper text-ink hover:bg-crust"}`}>{r.label}</button>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="label">Note {reason === "other" ? "(required)" : "(optional)"}</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-cream p-3">
            <span className="font-semibold">{mode === "void" ? "Order total" : "Amount"}</span>
            <span className="text-2xl font-black tabular-nums">{formatPeso(amount)}</span>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-danger" disabled={!canContinue} onClick={() => setStep("pin")}>
              {TITLES[mode]}: owner PIN
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
