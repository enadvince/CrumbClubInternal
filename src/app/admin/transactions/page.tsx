"use client";
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { CopyButton } from "@/components/CopyButton";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { formatPeso } from "@/lib/money";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/time";
import { downloadText } from "@/lib/csv";
import {
  applyTxnFilters, fetchAllTransactions, fetchLines, linesCsv, transactionsCsv, LINES_SELECT, TXN_SELECT,
  type LineRow, type TxnFilters, type TxnRow,
} from "@/lib/transactions";

const PAGE = 50;
type Option = { id: string; name: string };

export default function TransactionsPage() {
  const [filters, setFilters] = useState<TxnFilters>({});
  const [rows, setRows] = useState<TxnRow[] | null>(null);
  const [count, setCount] = useState(0);
  const [events, setEvents] = useState<Option[]>([]);
  const [staff, setStaff] = useState<Option[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TxnRow | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const supabase = getSupabase();
    supabase.from("events").select("id, name").order("starts_on", { ascending: false }).then(({ data }) => setEvents((data as Option[]) ?? []));
    supabase.from("staff").select("id, name").order("name").then(({ data }) => setStaff((data as Option[]) ?? []));
  }, []);

  const load = useCallback(async (offset: number) => {
    const { data, error, count } = await applyTxnFilters(
      getSupabase().from("transactions").select(TXN_SELECT, { count: "exact" }).order("client_created_at", { ascending: false }),
      filters,
    ).range(offset, offset + PAGE - 1);
    if (error) return setError(errorMessage(error));
    setError(null);
    setCount(count ?? 0);
    setRows((prev) => (offset === 0 ? (data as TxnRow[]) : [...(prev ?? []), ...(data as TxnRow[])]));
  }, [filters]);

  useEffect(() => {
    setRows(null);
    const t = setTimeout(() => load(0), 250);
    return () => clearTimeout(t);
  }, [load]);

  const set = (patch: Partial<TxnFilters>) => setFilters((f) => ({ ...f, ...patch }));

  async function exportCsv(kind: "transactions" | "lines") {
    setExporting(true);
    try {
      const supabase = getSupabase();
      const all = await fetchAllTransactions(supabase, filters);
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === "transactions") downloadText(`transactions-${stamp}.csv`, transactionsCsv(all));
      else downloadText(`transaction-lines-${stamp}.csv`, linesCsv(all, await fetchLines(supabase, all.map((t) => t.id))));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle="Every sale, including voids. Nothing is ever deleted."
        actions={
          <>
            <button className="btn-secondary" disabled={exporting} onClick={() => exportCsv("transactions")}>⬇ Transactions CSV</button>
            <button className="btn-secondary" disabled={exporting} onClick={() => exportCsv("lines")}>⬇ Line items CSV</button>
          </>
        }
      />
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Event" htmlFor="f-event">
          <select id="f-event" className="input" value={filters.eventId ?? ""} onChange={(e) => set({ eventId: e.target.value || undefined })}>
            <option value="">All events</option>
            {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
        <Field label="From" htmlFor="f-from">
          <input id="f-from" type="date" className="input" value={filters.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
        </Field>
        <Field label="To" htmlFor="f-to">
          <input id="f-to" type="date" className="input" value={filters.to ?? ""} min={filters.from} onChange={(e) => set({ to: e.target.value || undefined })} />
        </Field>
        <Field label="Order number" htmlFor="f-order">
          <input id="f-order" className="input" placeholder="e.g. 0042 or T1-261008" value={filters.orderSearch ?? ""} onChange={(e) => set({ orderSearch: e.target.value || undefined })} />
        </Field>
        <Field label="QR Ph reference" htmlFor="f-qr">
          <input id="f-qr" className="input" inputMode="numeric" placeholder="Search reference" value={filters.qrSearch ?? ""} onChange={(e) => set({ qrSearch: e.target.value || undefined })} />
        </Field>
        <Field label="Payment" htmlFor="f-pay">
          <select id="f-pay" className="input" value={filters.paymentMethod ?? ""} onChange={(e) => set({ paymentMethod: (e.target.value || undefined) as TxnFilters["paymentMethod"] })}>
            <option value="">Cash and QR Ph</option>
            <option value="cash">Cash</option>
            <option value="qr_ph">QR Ph</option>
          </select>
        </Field>
        <Field label="Staff" htmlFor="f-staff">
          <select id="f-staff" className="input" value={filters.staffId ?? ""} onChange={(e) => set({ staffId: e.target.value || undefined })}>
            <option value="">Everyone</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Status" htmlFor="f-status">
          <select id="f-status" className="input" value={filters.status ?? ""} onChange={(e) => set({ status: (e.target.value || undefined) as TxnFilters["status"] })}>
            <option value="">Completed and voided</option>
            <option value="completed">Completed</option>
            <option value="voided">Voided</option>
          </select>
        </Field>
        <label className="flex min-h-12 items-end gap-3 pb-2">
          <input type="checkbox" className="h-5 w-5 accent-caramel" checked={!!filters.hasBundle} onChange={(e) => set({ hasBundle: e.target.checked || undefined })} />
          Contains a bundle
        </label>
      </div>

      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {!rows ? <Spinner /> : rows.length === 0 ? <EmptyState>No transactions match these filters.</EmptyState> : (
        <>
          <p className="mb-2 text-sm text-ink-soft">{count} transaction{count === 1 ? "" : "s"}</p>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-cream text-left text-ink-soft">
                <tr>
                  <th className="p-3 font-semibold">Time</th>
                  <th className="p-3 font-semibold">Order</th>
                  <th className="p-3 font-semibold">Event</th>
                  <th className="p-3 font-semibold">Staff</th>
                  <th className="p-3 font-semibold">Items</th>
                  <th className="p-3 font-semibold">Payment</th>
                  <th className="p-3 text-right font-semibold">Total</th>
                  <th className="p-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-crust-dark">
                {rows.map((t) => (
                  <tr key={t.id} className="cursor-pointer hover:bg-cream" onClick={() => setSelected(t)}>
                    <td className="p-3 whitespace-nowrap">
                      <button className="text-left font-semibold underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setSelected(t); }}>
                        {formatDateTime(t.client_created_at)}
                      </button>
                    </td>
                    <td className="p-3 font-mono whitespace-nowrap">{t.order_number}</td>
                    <td className="p-3">{t.events?.name}</td>
                    <td className="p-3">{t.staff?.name}</td>
                    <td className="p-3">{t.item_count}{t.has_bundle && <span className="badge ml-1 bg-ube-light text-ube">Bundle</span>}</td>
                    <td className="p-3">{t.payment_method === "cash" ? "Cash" : <>QR Ph <span className="text-ink-soft">{t.qr_reference}</span></>}</td>
                    <td className={`p-3 text-right font-bold tabular-nums ${t.status === "voided" ? "text-ink-soft line-through" : ""}`}>{formatPeso(t.total_centavos)}</td>
                    <td className="p-3"><StatusCell t={t} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length < count && (
            <button className="btn-secondary mt-4 w-full" onClick={() => load(rows.length)}>Load more ({count - rows.length} more)</button>
          )}
        </>
      )}
      <TransactionDetail txn={selected} onClose={() => setSelected(null)} onVoided={() => { setSelected(null); load(0); }} />
    </>
  );
}

const FLAG_LABEL: Record<string, string> = {
  late_sync: "Synced after close",
  oversold: "Oversold",
  duplicate_qr_ref: "Duplicate QR ref",
  event_not_live: "Event not live",
};

/** QR payment: awaiting verification or verified (owner toggles it), plus the optional photo. */
function PaymentVerification({ txn }: { txn: TxnRow }) {
  const [status, setStatus] = useState(txn.payment_status);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!txn.payment_photo_path) return;
    getSupabase().storage.from("payment-proofs").createSignedUrl(txn.payment_photo_path, 600)
      .then(({ data }) => setPhotoUrl(data?.signedUrl ?? null));
  }, [txn.payment_photo_path]);
  async function toggle() {
    const verify = status !== "verified";
    const { error } = await getSupabase().rpc("set_payment_verified", { p_transaction_id: txn.id, p_verified: verify });
    if (error) return setErr(errorMessage(error));
    setStatus(verify ? "verified" : "awaiting_verification");
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <span className={`badge ${status === "verified" ? "bg-ok-light text-ok" : "bg-ube-light text-ube"}`}>{status === "verified" ? "✓ Verified" : "Awaiting verification"}</span>
      {photoUrl && <a href={photoUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold underline">Photo</a>}
      <button className="btn-secondary min-h-11 text-sm" onClick={toggle}>{status === "verified" ? "Unverify" : "Mark verified"}</button>
      {err && <span className="w-full text-xs text-danger">{err}</span>}
    </span>
  );
}

function StatusCell({ t }: { t: TxnRow }) {
  return (
    <div className="flex flex-wrap gap-1">
      {t.status === "voided" ? <span className="badge bg-ink text-white">✕ Voided</span> : <span className="badge bg-ok-light text-ok">✓ Completed</span>}
      {t.flags.map((f) => <span key={f} className="badge bg-warn-light text-warn">⚠ {FLAG_LABEL[f] ?? f}</span>)}
    </div>
  );
}

function TransactionDetail({ txn, onClose, onVoided }: { txn: TxnRow | null; onClose: () => void; onVoided: () => void }) {
  const [lines, setLines] = useState<LineRow[] | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLines(null); setVoiding(false); setReason(""); setPin(""); setError(null);
    if (!txn) return;
    getSupabase().from("transaction_lines").select(LINES_SELECT).eq("transaction_id", txn.id).order("position")
      .then(({ data, error }) => (error ? setError(errorMessage(error)) : setLines(data as unknown as LineRow[])));
  }, [txn]);

  async function doVoid() {
    if (!txn || !reason.trim() || !/^\d{4}$/.test(pin)) return;
    const { error } = await getSupabase().rpc("void_sale_with_owner_pin", { p_transaction_id: txn.id, p_reason: reason.trim(), p_pin: pin });
    setPin("");
    if (error) return setError(errorMessage(error));
    onVoided();
  }

  const cost = (lines ?? []).flatMap((l) => l.transaction_line_components).reduce((s, c) => s + c.unit_cost_centavos * c.quantity, 0);

  return (
    <Modal open={!!txn} onClose={onClose} title="Transaction" wide>
      {txn && (
        <div className="space-y-4">
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="text-sm">
              <p className="font-mono text-lg font-bold">{txn.order_number}</p>
              <p><strong>{formatDateTime(txn.client_created_at)}</strong> · {txn.events?.name}</p>
              <p>Rung up by <strong>{txn.staff?.name}</strong></p>
              <p className="text-ink-soft">Synced {formatDateTime(txn.synced_at)} · ID {txn.id.slice(0, 8)}</p>
            </div>
            <StatusCell t={txn} />
          </div>

          {!lines ? <Spinner /> : (
            <ul className="divide-y divide-crust-dark rounded-xl border border-crust-dark">
              {lines.map((l) => (
                <li key={l.id} className="p-3">
                  <div className="flex justify-between gap-3">
                    <span className="font-semibold">
                      {l.quantity}× {l.name_snapshot}
                      {l.kind === "bundle" && <span className="badge ml-1 bg-ube-light text-ube">Bundle</span>}
                    </span>
                    <span className="font-bold tabular-nums">{formatPeso(l.line_total_centavos)}</span>
                  </div>
                  {l.kind === "bundle" && (
                    <ul className="mt-1 space-y-0.5 text-sm text-ink-soft">
                      {l.transaction_line_components.map((c, i) => (
                        <li key={i} className="flex justify-between">
                          <span>{c.quantity}× {c.products?.name}</span>
                          <span className="tabular-nums">revenue {formatPeso(c.allocated_revenue_centavos)} · regular {formatPeso(c.regular_unit_price_centavos * c.quantity)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}

          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:max-w-md">
            <dt>Subtotal</dt><dd className="text-right tabular-nums">{formatPeso(txn.subtotal_centavos)}</dd>
            {txn.discount_centavos > 0 && (<>
              <dt>Discount{txn.discount_type === "percent" ? ` (${(txn.discount_value ?? 0) / 100}%)` : ""} — {txn.discount_reason}</dt>
              <dd className="text-right tabular-nums">−{formatPeso(txn.discount_centavos)}</dd>
            </>)}
            <dt className="font-bold">Total</dt><dd className="text-right font-bold tabular-nums">{formatPeso(txn.total_centavos)}</dd>
            <dt>Cost of goods</dt><dd className="text-right tabular-nums">{lines ? formatPeso(cost) : "…"}</dd>
            <dt>Payment</dt><dd className="text-right">{txn.payment_method === "cash" ? "Cash" : "QR Ph"}</dd>
            {txn.payment_method === "qr_ph" && (<>
              <dt>Reference</dt><dd className="flex items-center justify-end gap-2 font-mono">{txn.qr_reference}{txn.qr_reference && <CopyButton value={txn.qr_reference} />}</dd>
              <dt>Verification</dt><dd className="text-right"><PaymentVerification txn={txn} /></dd>
            </>)}
            {txn.payment_method === "cash" && (<>
              <dt>Cash received</dt><dd className="text-right tabular-nums">{formatPeso(txn.cash_received_centavos ?? 0)}</dd>
              <dt>Change given</dt><dd className="text-right tabular-nums">{formatPeso(txn.change_given_centavos ?? 0)}</dd>
            </>)}
          </dl>

          {txn.status === "voided" ? (
            <Notice>Voided {txn.voided_at ? formatDateTime(txn.voided_at) : ""}{txn.voided_by ? ` by ${txn.voided_by.name}` : ""}: {txn.void_reason}</Notice>
          ) : voiding ? (
            <div className="space-y-2 rounded-xl border-2 border-danger/40 p-3">
              <Field label="Reason for voiding (required)" htmlFor="void-reason">
                <input id="void-reason" autoFocus className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong item rung up, customer refunded" />
              </Field>
              <Field label="Owner PIN (required)" htmlFor="void-pin">
                <input id="void-pin" className="input w-32 text-center text-xl tracking-[0.5em]" type="password" inputMode="numeric" autoComplete="off"
                  maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
              </Field>
              <p className="text-sm text-ink-soft">The sale stays in history as voided and its pastries are returned to stock.</p>
              <div className="flex gap-2">
                <button className="btn-danger" disabled={!reason.trim() || pin.length !== 4} onClick={doVoid}>Void sale</button>
                <button className="btn-ghost" onClick={() => setVoiding(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn-secondary text-danger" onClick={() => setVoiding(true)}>Void this sale…</button>
          )}
        </div>
      )}
    </Modal>
  );
}
