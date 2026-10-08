"use client";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Modal } from "@/components/Modal";
import { MoneyInput } from "@/components/MoneyInput";
import { ConfirmModal } from "@/components/ConfirmModal";
import { getDb, type Denominations, type LocalShift } from "@/lib/offline/db";
import {
  ActionError, closeShiftLocally, drawerMovementLocally, openShiftLocally, unsyncedForShift,
} from "@/lib/offline/actions";
import {
  buildShiftReport, DENOMINATIONS, denominationTotal, provisionalLabel, varianceNeedsApproval, type ShiftReport,
} from "@/lib/pos/shift";
import { formatPeso, type Centavos } from "@/lib/money";
import { formatDateTime, formatTime } from "@/lib/time";
import type { SnapshotStaff } from "@/lib/pos/types";
import { OwnerPinGate } from "./OwnerPinGate";

type Staff = { id: string; name: string };

/** Count of each note and coin. Total in centavos is reported on every change. */
export function DenominationCounter({ value, onChange, idPrefix }: { value: Denominations; onChange: (d: Denominations) => void; idPrefix: string }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {DENOMINATIONS.map((d) => (
        <label key={d.key} htmlFor={`${idPrefix}-${d.key}`} className="flex items-center gap-2 rounded-xl border border-crust-dark bg-paper p-2">
          <span className="w-16 text-sm font-semibold">{d.label}<span className="block text-xs font-normal text-ink-soft">{d.kind}</span></span>
          <input
            id={`${idPrefix}-${d.key}`}
            className="input min-h-11 w-full px-2 text-right tabular-nums"
            inputMode="numeric"
            placeholder="0"
            value={value[d.key] ? String(value[d.key]) : ""}
            onChange={(e) => {
              const n = Math.min(99999, Number(e.target.value.replace(/\D/g, "") || 0));
              const next = { ...value };
              if (n > 0) next[d.key] = n; else delete next[d.key];
              onChange(next);
            }}
            aria-label={`Number of ${d.label} ${d.kind}s`}
          />
        </label>
      ))}
    </div>
  );
}

/** Before the first sale: the cashier enters the opening float (optionally counted by denomination). */
export function OpenShiftScreen({ eventId, staff, onOpened }: { eventId: string; staff: Staff; onOpened: (s: LocalShift) => void }) {
  const [byDenom, setByDenom] = useState(false);
  const [amount, setAmount] = useState<Centavos | null>(null);
  const [denoms, setDenoms] = useState<Denominations>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = byDenom ? denominationTotal(denoms) : amount;

  async function open() {
    if (total == null) return setError("Enter the opening float (₱0 if the drawer is empty).");
    setBusy(true);
    try {
      onOpened(await openShiftLocally(getDb(), { eventId, staffId: staff.id, staffName: staff.name, openingFloat: total, openingDenoms: byDenom ? denoms : null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open the shift");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">Open shift</h1>
      <p className="text-ink-soft">Count the cash in the drawer before the first sale. Works offline.</p>
      {error && <p role="alert" className="font-semibold text-danger">✕ {error}</p>}
      <div className="flex gap-2" role="radiogroup" aria-label="How to enter the float">
        {([[false, "Enter total"], [true, "Count by denomination"]] as const).map(([v, label]) => (
          <button key={label} role="radio" aria-checked={byDenom === v} onClick={() => setByDenom(v)}
            className={`btn flex-1 border-2 ${byDenom === v ? "border-caramel bg-caramel text-white hover:bg-caramel-dark" : "border-crust-dark bg-paper text-ink hover:bg-crust"}`}>{label}</button>
        ))}
      </div>
      {byDenom ? <DenominationCounter idPrefix="open" value={denoms} onChange={setDenoms} /> : (
        <label className="block max-w-xs">
          <span className="label">Opening float</span>
          <MoneyInput id="open-float" value={amount} onChange={setAmount} autoFocus />
        </label>
      )}
      <div className="flex items-center justify-between rounded-xl bg-cream p-3">
        <span className="font-semibold">Opening float</span>
        <span className="text-2xl font-black tabular-nums">{total == null ? "-" : formatPeso(total)}</span>
      </div>
      <button className="btn-primary h-14 w-full text-lg" disabled={busy || total == null} onClick={open}>Open shift and start selling</button>
    </div>
  );
}

function useShiftReport(shiftId: string | null): ShiftReport | null | undefined {
  return useLiveQuery(async () => {
    if (!shiftId) return null;
    const db = getDb();
    const shift = await db.shifts.get(shiftId);
    if (!shift) return null;
    return buildShiftReport(shift, {
      sales: await db.sales.where("shiftId").equals(shiftId).toArray(),
      refunds: await db.refunds.where("shiftId").equals(shiftId).toArray(),
      drawer: await db.drawer.where("shiftId").equals(shiftId).toArray(),
      unsynced: await unsyncedForShift(db, shiftId),
    });
  }, [shiftId]);
}

type Step = "summary" | "cash_in" | "cash_out" | "cash_out_pin" | "count" | "review" | "approve";

/** The shift panel: drawer movements, then a blind count to close. */
export function ShiftDrawerPanel({
  open, onClose, shiftId, staff, cashier, threshold, eventId, onChanged, onClosed,
}: {
  open: boolean; onClose: () => void; shiftId: string; staff: SnapshotStaff[]; cashier: Staff; threshold: Centavos; eventId: string;
  onChanged: (message: string) => void; onClosed: (shiftId: string) => void;
}) {
  const report = useShiftReport(open ? shiftId : null);
  const [step, setStep] = useState<Step>("summary");
  const [amount, setAmount] = useState<Centavos | null>(null);
  const [reason, setReason] = useState("");
  const [denoms, setDenoms] = useState<Denominations>({});
  const [countMode, setCountMode] = useState<"denoms" | "total">("denoms");
  const [countedTotal, setCountedTotal] = useState<Centavos | null>(null);
  const [note, setNote] = useState("");
  const [confirmClose, setConfirmClose] = useState<{ approverId: string | null; approverName: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counted = countMode === "denoms" ? denominationTotal(denoms) : countedTotal;
  const variance = report && counted != null ? counted - report.expectedCash : null;
  const needsApproval = variance != null && varianceNeedsApproval(variance, threshold);

  function reset() {
    setStep("summary"); setAmount(null); setReason(""); setDenoms({}); setCountedTotal(null); setNote(""); setError(null); setConfirmClose(null);
  }
  function close() { reset(); onClose(); }

  async function move(kind: "cash_in" | "cash_out", approver?: SnapshotStaff) {
    setError(null);
    try {
      await drawerMovementLocally(getDb(), { shiftId, kind, amount: amount ?? 0, reason, staffId: cashier.id, staffName: cashier.name, approverId: approver?.id ?? null });
      onChanged(`${kind === "cash_in" ? "Cash in" : "Cash out"} of ${formatPeso(amount ?? 0)} recorded.`);
      reset();
    } catch (e) {
      setError(e instanceof ActionError || e instanceof Error ? e.message : "Couldn't save that");
      setStep(kind);
    }
  }

  async function doClose(approverId: string | null, approverName: string | null) {
    if (!report || counted == null) return;
    try {
      await closeShiftLocally(getDb(), {
        shiftId, staffId: cashier.id, staffName: cashier.name, countedCash: counted, countedDenoms: countMode === "denoms" ? denoms : null,
        expectedCash: report.expectedCash, threshold, varianceNote: note, approverId, approverName,
      });
      reset();
      onClosed(shiftId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't close the shift");
      setConfirmClose(null);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Shift" wide>
      {!report ? <p className="text-ink-soft">Loading...</p> : (
        <div className="space-y-4">
          {error && <p role="alert" className="font-semibold text-danger">✕ {error}</p>}
          {step === "summary" && (
            <>
              <p className="text-sm text-ink-soft">
                Opened {formatDateTime(report.shift.openedAt)} by {report.shift.openedByName} with a float of {formatPeso(report.shift.openingFloat)}.
              </p>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Orders" value={String(report.orders)} />
                <Stat label="Net sales" value={formatPeso(report.netSales)} />
                <Stat label="Cash in / out" value={`${formatPeso(report.cashIn)} / ${formatPeso(report.cashOut)}`} />
                <Stat label="Refunds" value={formatPeso(report.refunds.total)} />
              </dl>
              {report.drawer.length > 0 && (
                <ul className="divide-y divide-crust-dark rounded-xl border border-crust-dark text-sm">
                  {report.drawer.map((m) => (
                    <li key={m.id} className="flex gap-3 p-2">
                      <span className="w-16 tabular-nums">{formatTime(m.createdAt)}</span>
                      <span className="w-20 font-semibold">{m.kind === "cash_in" ? "Cash in" : "Cash out"}</span>
                      <span className="flex-1">{m.reason}</span>
                      <span className="font-bold tabular-nums">{formatPeso(m.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" onClick={() => setStep("cash_in")}>+ Cash in</button>
                <button className="btn-secondary" onClick={() => setStep("cash_out")}>− Cash out</button>
                <button className="btn-danger ml-auto" onClick={() => setStep("count")}>Close shift</button>
              </div>
            </>
          )}

          {(step === "cash_in" || step === "cash_out") && (
            <div className="space-y-3">
              <h3 className="text-lg font-bold">{step === "cash_in" ? "Cash in (e.g. extra float)" : "Cash out (e.g. supplier pay-out)"}</h3>
              <label className="block max-w-xs"><span className="label">Amount</span><MoneyInput id="move-amount" value={amount} onChange={setAmount} autoFocus /></label>
              <label className="block"><span className="label">Reason (required)</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120} /></label>
              {step === "cash_out" && <p className="text-sm text-ink-soft">Cash out needs an owner PIN.</p>}
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={reset}>Cancel</button>
                <button className="btn-primary" disabled={!amount || !reason.trim()} onClick={() => (step === "cash_in" ? move("cash_in") : setStep("cash_out_pin"))}>
                  {step === "cash_in" ? "Record cash in" : "Continue: owner PIN"}
                </button>
              </div>
            </div>
          )}
          {step === "cash_out_pin" && (
            <OwnerPinGate staff={staff} eventId={eventId} title="Owner PIN for cash out" subtitle={`Take ${formatPeso(amount ?? 0)} out of the drawer: ${reason}`}
              onApproved={(o) => void move("cash_out", o)} onCancel={() => setStep("cash_out")} />
          )}

          {step === "count" && (
            <div className="space-y-3">
              <h3 className="text-lg font-bold">Count the drawer</h3>
              <p className="text-sm text-ink-soft">Count every note and coin first. The expected amount is shown after you enter your count.</p>
              <div className="flex gap-2" role="radiogroup" aria-label="How to enter the count">
                {([["denoms", "By denomination"], ["total", "Enter total"]] as const).map(([v, label]) => (
                  <button key={v} role="radio" aria-checked={countMode === v} onClick={() => setCountMode(v)}
                    className={`btn flex-1 border-2 ${countMode === v ? "border-caramel bg-caramel text-white hover:bg-caramel-dark" : "border-crust-dark bg-paper text-ink hover:bg-crust"}`}>{label}</button>
                ))}
              </div>
              {countMode === "denoms" ? <DenominationCounter idPrefix="close" value={denoms} onChange={setDenoms} /> : (
                <label className="block max-w-xs"><span className="label">Counted cash</span><MoneyInput id="count-total" value={countedTotal} onChange={setCountedTotal} autoFocus /></label>
              )}
              <div className="flex items-center justify-between rounded-xl bg-cream p-3">
                <span className="font-semibold">Counted</span>
                <span className="text-2xl font-black tabular-nums">{counted == null ? "-" : formatPeso(counted)}</span>
              </div>
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={reset}>Cancel</button>
                <button className="btn-primary" disabled={counted == null} onClick={() => setStep("review")}>Show expected</button>
              </div>
            </div>
          )}

          {step === "review" && variance != null && (
            <div className="space-y-3">
              <h3 className="text-lg font-bold">Cash check</h3>
              <dl className="grid grid-cols-3 gap-2">
                <Stat label="Expected" value={formatPeso(report.expectedCash)} />
                <Stat label="Counted" value={formatPeso(counted!)} />
                <Stat label="Variance" value={formatPeso(variance, { sign: true })} tone={variance === 0 ? "ok" : needsApproval ? "danger" : "warn"} />
              </dl>
              <p className="text-xs text-ink-soft">
                Expected = float {formatPeso(report.shift.openingFloat)} + cash sales {formatPeso(report.byMethod.cash)} − cash refunds {formatPeso(report.refunds.cash)}
                {" "}+ cash in {formatPeso(report.cashIn)} − cash out {formatPeso(report.cashOut)}
              </p>
              {needsApproval && (
                <>
                  <p role="alert" className="rounded-xl bg-danger-light p-3 font-semibold text-danger">
                    The variance is more than {formatPeso(threshold)}. An owner PIN and a note are needed to close.
                  </p>
                  <label className="block"><span className="label">Note (required)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></label>
                </>
              )}
              {report.unsynced.orders + report.unsynced.other > 0 && (
                <p className="text-sm text-warn">⚠ {provisionalLabel(report.unsynced)}. You can still close; the report becomes final when they sync.</p>
              )}
              <div className="flex gap-2">
                <button className="btn-secondary" onClick={() => setStep("count")}>Recount</button>
                <button className="btn-danger" disabled={needsApproval && !note.trim()}
                  onClick={() => (needsApproval ? setStep("approve") : setConfirmClose({ approverId: null, approverName: null }))}>
                  {needsApproval ? "Continue: owner PIN" : "Close shift"}
                </button>
              </div>
            </div>
          )}
          {step === "approve" && (
            <OwnerPinGate staff={staff} eventId={eventId} title="Owner PIN to close" subtitle={`Variance ${formatPeso(variance ?? 0, { sign: true })}: ${note}`}
              onApproved={(o) => setConfirmClose({ approverId: o.id, approverName: o.name })} onCancel={() => setStep("review")} />
          )}
          <ConfirmModal open={!!confirmClose} title="Close shift?" confirmLabel="Close shift" onClose={() => setConfirmClose(null)}
            onConfirm={() => doClose(confirmClose!.approverId, confirmClose!.approverName)}>
            <p>Counted {counted != null ? formatPeso(counted) : "-"}. After closing, a new shift must be opened before the next sale.</p>
          </ConfirmModal>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "danger" }) {
  const toneClass = tone === "danger" ? "bg-danger-light text-danger" : tone === "warn" ? "bg-warn-light text-warn" : tone === "ok" ? "bg-ok-light text-ok" : "bg-cream";
  return (
    <div className={`rounded-xl p-3 ${toneClass}`}>
      <dt className="text-xs opacity-80">{label}</dt>
      <dd className="text-lg font-black tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Full-page shift report (on screen and printable to A4). Marked provisional while
 * anything from the shift is unsynced; it turns final by itself once they sync.
 */
export function ShiftReportPage({ shiftId, businessName, deviceCode, onBack }: { shiftId: string; businessName: string; deviceCode?: string; onBack: () => void }) {
  const report = useShiftReport(shiftId);
  if (report === undefined) return <p className="p-6 text-ink-soft">Loading...</p>;
  if (!report) return <div className="p-6"><p>Shift not found on this tablet.</p><button className="btn-secondary mt-3" onClick={onBack}>Back</button></div>;
  return <ShiftReportView report={report} businessName={businessName} deviceCode={deviceCode} onBack={onBack} />;
}

export function ShiftReportView({ report, businessName, deviceCode, onBack }: { report: ShiftReport; businessName: string; deviceCode?: string; onBack?: () => void }) {
  const provisional = provisionalLabel(report.unsynced);
  const s = report.shift;
  return (
    <article className="print-page mx-auto w-full max-w-3xl space-y-5 p-4" aria-label="Shift report">
      <div className="no-print flex flex-wrap gap-2">
        {onBack && <button className="btn-secondary" onClick={onBack}>← Back to POS</button>}
        <button className="btn-primary" onClick={() => window.print()}>Print (A4)</button>
      </div>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Shift report</h1>
        <p className="text-ink-soft">{businessName}{deviceCode ? ` · Tablet ${deviceCode}` : ""}</p>
        <p className="text-sm">Opened {formatDateTime(s.openedAt)} by {s.openedByName}{s.closedAt ? ` · Closed ${formatDateTime(s.closedAt)} by ${s.closedByName}` : " · Still open"}</p>
        <p data-testid="report-status" className={`badge px-3 py-1 text-sm ${provisional ? "bg-warn-light text-warn" : "bg-ok-light text-ok"}`}>
          {provisional ?? "Final: everything synced"}
        </p>
      </header>
      <section>
        <h2 className="mb-2 font-bold">Sales</h2>
        <table className="w-full text-sm"><tbody className="divide-y divide-crust-dark">
          <Row label="Orders" value={String(report.orders)} />
          <Row label="Gross sales" value={formatPeso(report.grossSales)} />
          <Row label="Discounts" value={formatPeso(-report.discounts)} />
          <Row label={`Voids (${report.voids.count})`} value={formatPeso(report.voids.total)} />
          <Row label={`Refunds (${report.refunds.count})`} value={formatPeso(-report.refunds.total)} />
          <Row label="Net sales" value={formatPeso(report.netSales)} strong />
          <Row label="Cash" value={formatPeso(report.byMethod.cash)} />
          <Row label="QR" value={formatPeso(report.byMethod.qr)} />
          <Row label={`QR awaiting verification (${report.qrAwaiting.count})`} value={formatPeso(report.qrAwaiting.total)} />
        </tbody></table>
      </section>
      <section>
        <h2 className="mb-2 font-bold">Cash drawer</h2>
        <table className="w-full text-sm"><tbody className="divide-y divide-crust-dark">
          <Row label="Opening float" value={formatPeso(s.openingFloat)} />
          <Row label="Cash sales" value={formatPeso(report.byMethod.cash)} />
          <Row label="Cash refunds" value={formatPeso(-report.refunds.cash)} />
          <Row label="Cash in" value={formatPeso(report.cashIn)} />
          <Row label="Cash out" value={formatPeso(-report.cashOut)} />
          <Row label="Expected" value={formatPeso(report.expectedCash)} strong />
          <Row label="Counted" value={report.countedCash == null ? "Not counted yet" : formatPeso(report.countedCash)} />
          <Row label="Variance" value={report.variance == null ? "-" : formatPeso(report.variance, { sign: true })} strong />
          {s.varianceNote && <Row label="Variance note" value={`${s.varianceNote}${s.approvedByName ? ` (approved by ${s.approvedByName})` : ""}`} />}
        </tbody></table>
        {report.drawer.length > 0 && (
          <ul className="mt-2 text-sm">
            {report.drawer.map((m) => <li key={m.id}>{formatTime(m.createdAt)} · {m.kind === "cash_in" ? "Cash in" : "Cash out"} {formatPeso(m.amount)} · {m.reason} · {m.staffName}</li>)}
          </ul>
        )}
      </section>
      <section>
        <h2 className="mb-2 font-bold">Top items</h2>
        {report.topItems.length === 0 ? <p className="text-sm text-ink-soft">No sales.</p> : (
          <table className="w-full text-sm"><tbody className="divide-y divide-crust-dark">
            {report.topItems.map((i) => <Row key={i.name} label={`${i.quantity}× ${i.name}`} value={formatPeso(i.revenue)} />)}
          </tbody></table>
        )}
      </section>
      <section className="text-sm">
        <p><strong>Cashiers:</strong> {report.cashiers.join(", ") || "-"}</p>
        {s.approvedByName && <p><strong>Owner approval:</strong> {s.approvedByName}</p>}
      </section>
    </article>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className={strong ? "font-bold" : ""}>
      <td className="py-1.5 pr-3">{label}</td>
      <td className="py-1.5 text-right tabular-nums">{value}</td>
    </tr>
  );
}
