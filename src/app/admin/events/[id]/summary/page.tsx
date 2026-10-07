"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { Notice, Spinner } from "@/components/ui";
import { EventStatusBadge } from "@/components/StatusBadge";
import { formatPeso } from "@/lib/money";
import { errorMessage } from "@/lib/errors";
import { formatDateRange, formatDateTime, formatTime } from "@/lib/time";
import { leftover, leftoverUnitCost, type EventReport } from "@/lib/eventReport";

export default function SummaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [r, setR] = useState<EventReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState<string | null>(null);

  useEffect(() => {
    getSupabase().rpc("event_report", { p_event_id: id }).then(({ data, error }) => (error ? setError(errorMessage(error)) : setR(data as EventReport)));
  }, [id]);

  if (!r) return error ? <Notice tone="danger">{error}</Notice> : <Spinner />;

  const t = r.totals;
  const profit = t.revenue_centavos - t.cost_centavos;
  const margin = t.revenue_centavos ? (profit / t.revenue_centavos) * 100 : 0;
  const wasteCost = r.products.reduce((s, p) => s + p.waste_cost_centavos, 0);
  const unsoldCost = r.products.reduce((s, p) => s + leftover(p) * leftoverUnitCost(p), 0);
  const sorted = [...r.products].sort((a, b) => b.revenue_centavos - a.revenue_centavos);

  const text = [
    `${r.event.name} — ${formatDateRange(r.event.starts_on, r.event.ends_on)}${r.event.venue ? ` @ ${r.event.venue}` : ""}`,
    `Revenue ${formatPeso(t.revenue_centavos)} · ${t.transactions} sales · ${t.items} items`,
    `Gross profit ${formatPeso(profit)} (${margin.toFixed(1)}%)`,
    `Cash ${formatPeso(t.cash_centavos)} · QR Ph ${formatPeso(t.qr_centavos)}`,
    r.cash.counted_cash_centavos != null ? `Drawer: expected ${formatPeso(r.cash.expected_cash_centavos)}, counted ${formatPeso(r.cash.counted_cash_centavos)}, variance ${formatPeso(r.cash.variance_centavos ?? 0, { sign: true })}` : "",
    `Top: ${sorted.slice(0, 3).map((p) => `${p.name} ${p.sold}`).join(", ")}`,
    `Waste ${formatPeso(wasteCost)} · unsold ${formatPeso(unsoldCost)} at cost`,
  ].filter(Boolean).join("\n");

  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: r!.event.name, text });
      else { await navigator.clipboard.writeText(text); setShared("Summary copied to clipboard."); }
    } catch { /* cancelled */ }
  }

  return (
    <article className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link href={`/admin/events/${id}`} className="font-semibold text-caramel underline">← Event</Link>
        <span className="flex-1" />
        <button className="btn-secondary" onClick={share}>Share</button>
        <button className="btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      {shared && <Notice tone="ok" className="no-print mb-4">{shared}</Notice>}

      <header className="mb-6 border-b-2 border-ink pb-4">
        <p className="text-sm font-bold tracking-wide text-caramel uppercase">Crumb Club · Event summary</p>
        <h1 className="text-3xl font-black">{r.event.name}</h1>
        <p>{formatDateRange(r.event.starts_on, r.event.ends_on)}{r.event.venue ? ` · ${r.event.venue}` : ""} · <EventStatusBadge status={r.event.status} /></p>
        {r.event.closed_at && <p className="text-sm text-ink-soft">Closed {formatDateTime(r.event.closed_at)}</p>}
        {r.event.status !== "closed" && <p className="no-print mt-2 text-sm font-semibold text-warn">⚠ Preview: the event is still open, figures may change.</p>}
      </header>

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Revenue" value={formatPeso(t.revenue_centavos)} />
        <Kpi label="Gross profit" value={formatPeso(profit)} sub={`${margin.toFixed(1)}% margin`} />
        <Kpi label="Sales" value={String(t.transactions)} sub={`${t.items} items`} />
        <Kpi label="Avg order" value={formatPeso(t.transactions ? Math.round(t.revenue_centavos / t.transactions) : 0)} />
        <Kpi label="Cash" value={formatPeso(t.cash_centavos)} />
        <Kpi label="QR Ph" value={formatPeso(t.qr_centavos)} sub={`${t.qr_count} payments`} />
        <Kpi label="Discounts" value={formatPeso(t.discount_centavos)} />
        <Kpi label="Voided" value={String(t.voided)} sub={formatPeso(t.voided_total_centavos)} />
      </section>

      <Section title="Cash drawer">
        <dl className="grid max-w-md grid-cols-2 gap-y-1 tabular-nums">
          <dt>Opening float</dt><dd className="text-right">{formatPeso(r.cash.opening_float_centavos)}</dd>
          <dt>Cash sales</dt><dd className="text-right">{formatPeso(r.cash.cash_sales_centavos)}</dd>
          <dt className="font-bold">Expected</dt><dd className="text-right font-bold">{formatPeso(r.cash.expected_cash_centavos)}</dd>
          <dt>Counted</dt><dd className="text-right">{r.cash.counted_cash_centavos != null ? formatPeso(r.cash.counted_cash_centavos) : "—"}</dd>
          <dt className="font-bold">Variance</dt>
          <dd className="text-right font-bold">{r.cash.variance_centavos != null ? (r.cash.variance_centavos === 0 ? "✓ Balanced" : formatPeso(r.cash.variance_centavos, { sign: true })) : "—"}</dd>
        </dl>
        {r.cash.notes && <p className="mt-2 text-sm">Notes: {r.cash.notes}</p>}
      </Section>

      <Section title="Products">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-ink-soft">
            <tr><th className="py-1">Product</th><th className="text-right">Sold</th><th className="text-right">Stocked</th><th className="text-right">Sell-through</th><th className="text-right">Revenue</th><th className="text-right">Sold out</th><th className="text-right">Left</th></tr>
          </thead>
          <tbody className="divide-y divide-crust-dark">
            {sorted.map((p) => {
              const stocked = p.starting_stock + p.restocked;
              return (
                <tr key={p.event_product_id}>
                  <td className="py-1">{p.name}</td>
                  <td className="text-right">{p.sold}</td>
                  <td className="text-right">{stocked}</td>
                  <td className="text-right">{stocked ? `${Math.round((p.sold / stocked) * 100)}%` : "—"}</td>
                  <td className="text-right">{formatPeso(p.revenue_centavos)}</td>
                  <td className="text-right">{p.sold_out_at ? formatTime(p.sold_out_at) : "—"}</td>
                  <td className="text-right">{leftover(p)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      {r.bundles.length > 0 && (
        <Section title="Bundles">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-ink-soft"><tr><th className="py-1">Bundle</th><th className="text-right">Sold</th><th className="text-right">Revenue</th></tr></thead>
            <tbody className="divide-y divide-crust-dark">
              {r.bundles.map((b) => <tr key={b.bundle_id}><td className="py-1">{b.name}</td><td className="text-right">{b.units}</td><td className="text-right">{formatPeso(b.revenue_centavos)}</td></tr>)}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="Waste and leftovers (at cost)">
        <p>Waste: <strong>{formatPeso(wasteCost)}</strong> · Unsold leftovers: <strong>{formatPeso(unsoldCost)}</strong></p>
      </Section>

      {t.flagged > 0 && (
        <Notice tone="warn" className="mt-4">{t.flagged} sale(s) have flags (e.g. synced after close, duplicate QR reference). Review them in Transactions.</Notice>
      )}
    </article>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-3">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className="text-xl font-black tabular-nums">{value}</p>
      {sub && <p className="text-xs text-ink-soft">{sub}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 break-inside-avoid">
      <h2 className="mb-2 border-b border-crust-dark pb-1 text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}
