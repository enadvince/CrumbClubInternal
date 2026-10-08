"use client";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/components/ConfirmModal";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { MoneyInput } from "@/components/MoneyInput";
import { formatPeso } from "@/lib/money";
import { errorMessage } from "@/lib/errors";
import { formatTime, timeAgo } from "@/lib/time";
import { leftover, type EventReport } from "@/lib/eventReport";

export default function ClosePage({ params }: { params: Promise<{ id: string }> }) {
  const [ask, confirmEl] = useConfirm();
  const { id } = use(params);
  const router = useRouter();
  const [report, setReport] = useState<EventReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingFloat, setOpeningFloat] = useState<number | null>(null);
  const [counted, setCounted] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [waste, setWaste] = useState<Record<string, number>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await getSupabase().rpc("event_report", { p_event_id: id });
    if (error) return setError(errorMessage(error));
    const r = data as EventReport;
    setReport(r);
    setOpeningFloat((f) => f ?? r.cash.opening_float_centavos);
  }, [id]);

  useEffect(() => { load(); }, [load]);
  // Ticks are stored on the server (payment_status = verified), so every owner sees the same list.
  useEffect(() => {
    getSupabase().from("transactions").select("id, payment_status").eq("event_id", id).eq("payment_method", "qr_ph")
      .then(({ data }) => setTicked(Object.fromEntries((data ?? []).map((t: { id: string; payment_status: string }) => [t.id, t.payment_status === "verified"]))));
  }, [id]);

  async function tick(txnId: string, value: boolean) {
    setTicked((t) => ({ ...t, [txnId]: value }));
    const { error } = await getSupabase().rpc("set_payment_verified", { p_transaction_id: txnId, p_verified: value });
    if (error) {
      setTicked((t) => ({ ...t, [txnId]: !value }));
      setError(errorMessage(error));
    }
  }

  async function saveFloat(v: number | null) {
    setOpeningFloat(v);
    if (v == null) return;
    const { error } = await getSupabase().rpc("set_opening_float", { p_event_id: id, p_opening_float_centavos: v });
    if (error) setError(errorMessage(error));
    else load();
  }

  const expected = report ? (openingFloat ?? 0) + report.cash.cash_sales_centavos : 0;
  const variance = counted != null ? counted - expected : null;
  const qrTicked = report?.qr_payments.filter((q) => ticked[q.id]) ?? [];
  const wasteCost = useMemo(
    () => (report?.products ?? []).reduce((s, p) => s + (waste[p.event_product_id] ?? 0) * p.cost_centavos, 0),
    [report, waste],
  );
  const unsoldCost = useMemo(
    () => (report?.products ?? []).reduce((s, p) => s + Math.max(0, leftover(p) - (waste[p.event_product_id] ?? 0)) * p.cost_centavos, 0),
    [report, waste],
  );

  async function close() {
    if (!report || counted == null) return;
    const deviceUnsynced = report.device?.unsynced_count ?? 0;
    const msg = deviceUnsynced > 0
      ? `The tablet reported ${deviceUnsynced} unsynced sale(s). Closing now locks sales; those will still upload and be flagged. Close anyway?`
      : "Close this event? Sales will be locked.";
    if (!(await ask({ title: "Close event?", body: msg, confirmLabel: "Close event and lock sales" }))) return;
    setBusy(true);
    const { error } = await getSupabase().rpc("close_event", {
      p_event_id: id,
      p_counted_cash_centavos: counted,
      p_notes: notes || null,
      p_waste: Object.entries(waste).filter(([, q]) => q > 0).map(([event_product_id, quantity]) => ({ event_product_id, quantity })),
    });
    setBusy(false);
    if (error) return setError(errorMessage(error));
    router.push(`/admin/events/${id}/summary`);
  }

  if (!report) return error ? <Notice tone="danger">{error}</Notice> : <Spinner />;
  const closed = report.event.status === "closed";

  return (
    <>
      {confirmEl}
      <p className="mb-2 text-sm"><Link href={`/admin/events/${id}`} className="font-semibold text-caramel underline">← {report.event.name}</Link></p>
      <PageHeader title="End of day" subtitle="Count the cash, tick off QR Ph payments, record waste, then close the event." />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {closed && <Notice className="mb-4">This event is already closed. <Link className="underline" href={`/admin/events/${id}/summary`}>View the summary</Link>.</Notice>}

      {report.device?.last_seen_at && (
        <Notice tone={(report.device.unsynced_count ?? 0) > 0 ? "warn" : "ok"} className="mb-6">
          Tablet last checked in {timeAgo(report.device.last_seen_at)}.{" "}
          {(report.device.unsynced_count ?? 0) > 0
            ? `It's holding ${report.device.unsynced_count} unsynced sale(s). Connect it to the internet and wait for “all synced” before closing.`
            : "It reported all sales synced."}{" "}
          Latest sale received: {report.totals.last_synced_at ? timeAgo(report.totals.last_synced_at) : "none"}.
        </Notice>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="card space-y-3 p-5" aria-labelledby="cash-h">
          <h2 id="cash-h" className="text-lg font-bold">💵 Cash drawer</h2>
          <Field label="Opening float" htmlFor="float">
            <MoneyInput id="float" value={openingFloat} onChange={(v) => saveFloat(v)} />
          </Field>
          <dl className="grid grid-cols-2 gap-y-1 tabular-nums">
            <dt>Opening float</dt><dd className="text-right">{formatPeso(openingFloat ?? 0)}</dd>
            <dt>+ Cash sales (received − change)</dt><dd className="text-right">{formatPeso(report.cash.cash_sales_centavos)}</dd>
            <dt className="font-bold">= Expected in drawer</dt><dd className="text-right text-xl font-black">{formatPeso(expected)}</dd>
          </dl>
          <Field label="Counted cash" htmlFor="counted">
            <MoneyInput id="counted" value={counted} onChange={setCounted} />
          </Field>
          {variance != null && (
            <p role="status" className={`rounded-xl p-3 text-lg font-bold ${variance === 0 ? "bg-ok-light text-ok" : "bg-warn-light text-warn"}`}>
              {variance === 0 ? "✓ Drawer balances exactly" : variance > 0 ? `⚠ Over by ${formatPeso(variance)}` : `⚠ Short by ${formatPeso(-variance)}`}
            </p>
          )}
          <Field label="Notes" htmlFor="notes">
            <textarea id="notes" rows={2} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. ₱20 coin found under the table" />
          </Field>
        </section>

        <section className="card space-y-3 p-5" aria-labelledby="qr-h">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 id="qr-h" className="text-lg font-bold">📱 QR Ph payments</h2>
            <p className="text-sm">Ticked {qrTicked.length} of {report.qr_payments.length}</p>
          </div>
          <p className="text-sm text-ink-soft">Open the GCash merchant transaction history and tick each one you can match. Ticking marks the payment as verified.</p>
          <p className="text-lg">Expected QR Ph total: <strong className="tabular-nums">{formatPeso(report.totals.qr_centavos)}</strong></p>
          <ul className="max-h-96 divide-y divide-crust-dark overflow-y-auto rounded-xl border border-crust-dark">
            {report.qr_payments.length === 0 && <li className="p-3 text-ink-soft">No QR Ph payments.</li>}
            {report.qr_payments.map((q) => (
              <li key={q.id}>
                <label className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2">
                  <input type="checkbox" className="h-5 w-5 accent-ok" checked={!!ticked[q.id]} onChange={(e) => tick(q.id, e.target.checked)} />
                  <span className="w-20 tabular-nums">{formatTime(q.time)}</span>
                  <span className="flex-1 font-mono">{q.reference}{q.flags.includes("duplicate_qr_ref") && <span className="badge ml-2 bg-warn-light text-warn">⚠ duplicate ref</span>}</span>
                  <span className="font-bold tabular-nums">{formatPeso(q.amount_centavos)}</span>
                </label>
              </li>
            ))}
          </ul>
          {report.qr_payments.length > 0 && (
            <p className="text-sm">Ticked total {formatPeso(qrTicked.reduce((s, q) => s + q.amount_centavos, 0))} · unticked {formatPeso(report.totals.qr_centavos - qrTicked.reduce((s, q) => s + q.amount_centavos, 0))}</p>
          )}
        </section>
      </div>

      <section className="card mt-6 p-5" aria-labelledby="stock-h">
        <h2 id="stock-h" className="mb-1 text-lg font-bold">🥐 Leftover stock</h2>
        <p className="mb-3 text-sm text-ink-soft">Enter anything thrown away (waste). The rest counts as unsold and is valued at cost.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm tabular-nums">
            <thead className="text-left text-ink-soft">
              <tr>
                <th className="py-2 font-semibold">Product</th>
                <th className="py-2 text-right font-semibold">Start</th>
                <th className="py-2 text-right font-semibold">Restocked</th>
                <th className="py-2 text-right font-semibold">Sold</th>
                <th className="py-2 text-right font-semibold">Other out</th>
                <th className="py-2 text-right font-semibold">Leftover</th>
                <th className="py-2 text-right font-semibold">Waste now</th>
                <th className="py-2 text-right font-semibold">Unsold value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-crust-dark">
              {report.products.map((p) => {
                const left = leftover(p);
                const w = waste[p.event_product_id] ?? 0;
                return (
                  <tr key={p.event_product_id}>
                    <td className="py-2 font-semibold">{p.name}{p.sold_out_at && <span className="ml-2 text-xs font-normal text-ink-soft">sold out {formatTime(p.sold_out_at)}</span>}</td>
                    <td className="py-2 text-right">{p.starting_stock}</td>
                    <td className="py-2 text-right">{p.restocked || "-"}</td>
                    <td className="py-2 text-right">{p.sold}</td>
                    <td className="py-2 text-right">{p.waste + p.staff_meal + p.giveaway - p.correction || "-"}</td>
                    <td className="py-2 text-right font-bold">{left}</td>
                    <td className="py-1 text-right">
                      <input type="number" min={0} max={left} disabled={closed || left === 0} aria-label={`Waste for ${p.name}`}
                        className="input ml-auto w-20 text-right" value={w || ""}
                        onChange={(e) => setWaste((x) => ({ ...x, [p.event_product_id]: Math.min(left, Math.max(0, Math.floor(Number(e.target.value) || 0))) }))} />
                    </td>
                    <td className="py-2 text-right">{formatPeso((left - w) * p.cost_centavos)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3">
          Waste being recorded now: <strong>{formatPeso(wasteCost)}</strong> at cost ·
          Unsold leftovers: <strong>{formatPeso(unsoldCost)}</strong> at cost ·
          Waste already recorded: <strong>{formatPeso(report.products.reduce((s, p) => s + p.waste_cost_centavos, 0))}</strong>
        </p>
      </section>

      {!closed && (
        <div className="no-print sticky bottom-0 -mx-4 mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-crust-dark bg-cream/95 px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8">
          {counted == null && <span className="text-sm font-semibold text-warn">Enter the counted cash to close.</span>}
          <Link href={`/admin/events/${id}/summary`} className="btn-secondary">Preview summary</Link>
          <button className="btn-primary" disabled={busy || counted == null} onClick={close}>{busy ? "Closing…" : "🔒 Close event and lock sales"}</button>
        </div>
      )}
    </>
  );
}
