"use client";
import { ChartCard, ColumnBars, DataTable, Heatmap, RankedBars, SERIES_2 } from "@/components/charts/Charts";
import { formatPeso } from "@/lib/money";
import { formatTime } from "@/lib/time";
import { insights, pctChange, type DashboardReport } from "@/lib/dashboard";
import { useState } from "react";

type Metric = "revenue" | "units" | "profit";
const peso = (c: number) => formatPeso(c, { trimZeros: true });
const pesoAxis = (c: number) => (Math.abs(c) >= 100000 ? `₱${(c / 100000).toFixed(c % 100000 ? 1 : 0)}k` : `₱${Math.round(c / 100)}`);
const pct = (n: number) => `${n.toFixed(1)}%`;

/** All dashboard sections for one report (plus optional comparison report). */
export function DashboardBody({ report, prev, prevLabel }: { report: DashboardReport; prev: DashboardReport | null; prevLabel?: string }) {
  const [metric, setMetric] = useState<Metric>("revenue");
  return (
    <>
      <Insights lines={insights(report, prev, prevLabel)} />
      <Kpis r={report} prev={prev} prevLabel={prevLabel} />
      <div className="grid gap-4 xl:grid-cols-2">
        <ProductChart r={report} metric={metric} setMetric={setMetric} />
        <HourChart r={report} />
      </div>
      <BundleTable r={report} />
      <div className="grid gap-4 xl:grid-cols-2">
        <MixPicks r={report} />
        <ItemsDistribution r={report} />
      </div>
      <SellThrough r={report} />
      <div className="grid gap-4 xl:grid-cols-2">
        <StaffTable r={report} />
        <WasteAndDiscounts r={report} />
      </div>
    </>
  );
}

function Insights({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <section className="card border-l-4 border-l-ube p-4" aria-labelledby="ins-h">
      <h2 id="ins-h" className="mb-2 font-bold">💡 Insights</h2>
      <ul className="list-disc space-y-1 pl-5">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </section>
  );
}

function Delta({ current, previous, invert = false, label }: { current: number; previous: number | undefined; invert?: boolean; label?: string }) {
  if (previous === undefined) return null;
  const ch = pctChange(current, previous);
  if (ch === null) return <p className="text-xs text-ink-soft">no data for {label}</p>;
  const good = invert ? ch < 0 : ch > 0;
  const flat = Math.abs(ch) < 0.5;
  return (
    <p className={`text-xs font-semibold ${flat ? "text-ink-soft" : good ? "text-ok" : "text-danger"}`}>
      <span aria-hidden>{flat ? "→" : ch > 0 ? "▲" : "▼"}</span> {flat ? "flat" : `${ch > 0 ? "+" : ""}${ch.toFixed(0)}%`} vs {label}
    </p>
  );
}

function Kpi({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="card p-3">
      <p className="text-xs font-semibold text-ink-soft">{label}</p>
      <p className="text-2xl font-black tabular-nums">{value}</p>
      {sub && <p className="text-xs text-ink-soft">{sub}</p>}
      {children}
    </div>
  );
}

function Kpis({ r, prev, prevLabel }: { r: DashboardReport; prev: DashboardReport | null; prevLabel?: string }) {
  const k = r.kpis;
  const p = prev?.kpis;
  const profit = k.revenue_centavos - k.cost_centavos;
  const margin = k.revenue_centavos ? (profit / k.revenue_centavos) * 100 : 0;
  const aov = k.transactions ? Math.round(k.revenue_centavos / k.transactions) : 0;
  const cashPct = k.revenue_centavos ? (k.cash_centavos / k.revenue_centavos) * 100 : 0;
  const bundleShare = k.revenue_centavos ? (k.bundle_revenue_centavos / k.revenue_centavos) * 100 : 0;
  const attach = k.transactions ? (k.transactions_with_bundle / k.transactions) * 100 : 0;
  const pv = (fn: (x: NonNullable<typeof p>) => number) => (p ? fn(p) : undefined);
  return (
    <>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Key figures">
        <Kpi label="Revenue" value={peso(k.revenue_centavos)}><Delta current={k.revenue_centavos} previous={pv((x) => x.revenue_centavos)} label={prevLabel} /></Kpi>
        <Kpi label="Gross profit" value={peso(profit)}><Delta current={profit} previous={pv((x) => x.revenue_centavos - x.cost_centavos)} label={prevLabel} /></Kpi>
        <Kpi label="Gross margin" value={pct(margin)} sub={`Cost of goods ${peso(k.cost_centavos)}`} />
        <Kpi label="Transactions" value={String(k.transactions)}><Delta current={k.transactions} previous={pv((x) => x.transactions)} label={prevLabel} /></Kpi>
        <Kpi label="Avg order value" value={peso(aov)}><Delta current={aov} previous={pv((x) => (x.transactions ? x.revenue_centavos / x.transactions : 0))} label={prevLabel} /></Kpi>
        <Kpi label="Items sold" value={String(k.items)}><Delta current={k.items} previous={pv((x) => x.items)} label={prevLabel} /></Kpi>
      </section>
      <section className="grid gap-3 md:grid-cols-3" aria-label="Payment and bundle mix">
        <div className="card p-3 md:col-span-1">
          <p className="text-xs font-semibold text-ink-soft">Cash vs QR Ph</p>
          <div className="mt-2 flex h-3 overflow-hidden rounded-full" aria-hidden>
            <div style={{ width: `${cashPct}%`, background: "var(--color-series-1)" }} />
            <div className="ml-0.5 flex-1" style={{ background: "var(--color-series-2)" }} />
          </div>
          <dl className="mt-2 grid grid-cols-2 text-sm">
            <div><dt className="font-semibold"><span aria-hidden style={{ color: "var(--color-series-1)" }}>■ </span>Cash</dt><dd className="tabular-nums">{peso(k.cash_centavos)} · {pct(cashPct)}</dd></div>
            <div className="text-right"><dt className="font-semibold"><span aria-hidden style={{ color: "var(--color-series-2)" }}>■ </span>QR Ph</dt><dd className="tabular-nums">{peso(k.qr_centavos)} · {pct(100 - cashPct)}</dd></div>
          </dl>
        </div>
        <Kpi label="Bundle share of revenue" value={pct(bundleShare)} sub={`${peso(k.bundle_revenue_centavos)} from bundles`} />
        <Kpi label="Bundle attach rate" value={pct(attach)} sub={`${k.transactions_with_bundle} of ${k.transactions} sales had a bundle`} />
      </section>
    </>
  );
}

function ProductChart({ r, metric, setMetric }: { r: DashboardReport; metric: Metric; setMetric: (m: Metric) => void }) {
  const rows = r.by_product.map((p) => ({
    name: p.name,
    revenue: p.revenue_centavos,
    units: p.units,
    profit: p.revenue_centavos - p.cost_centavos,
  }));
  const data = [...rows].sort((a, b) => b[metric] - a[metric]).map((x) => ({ label: x.name, value: x[metric] }));
  const fmt = metric === "units" ? (v: number) => `${v} sold` : peso;
  return (
    <ChartCard
      title="By product"
      subtitle="Bundle sales count toward each pastry inside them"
      actions={
        <div className="flex gap-1" role="radiogroup" aria-label="Metric">
          {(["revenue", "units", "profit"] as Metric[]).map((m) => (
            <button key={m} role="radio" aria-checked={metric === m} onClick={() => setMetric(m)}
              className={`btn min-h-11 border-2 px-3 text-sm ${metric === m ? "border-caramel bg-crust hover:bg-crust-dark" : "border-crust-dark bg-paper hover:bg-crust active:bg-crust-dark"}`}>
              {m === "profit" ? "Gross profit" : m === "units" ? "Units" : "Revenue"}
            </button>
          ))}
        </div>
      }
      table={<DataTable headers={["Product", "Units", "Revenue", "Gross profit"]} rows={rows.map((x) => [x.name, x.units, peso(x.revenue), peso(x.profit)])} />}
    >
      <RankedBars data={data} format={fmt} axisFormat={metric === "units" ? (v) => String(v) : pesoAxis} />
    </ChartCard>
  );
}

function HourChart({ r }: { r: DashboardReport }) {
  const days = new Set(r.by_day_hour.map((c) => c.day));
  const hours = r.by_hour.map((h) => h.hour);
  const lo = Math.min(...hours);
  const hi = Math.max(...hours);
  const byHour = new Map(r.by_hour.map((h) => [h.hour, h]));
  const data = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((h) => ({
    label: `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`,
    value: byHour.get(h)?.revenue_centavos ?? 0,
  }));
  return (
    <ChartCard
      title="Sales by hour"
      subtitle="Revenue per hour of day (Manila time)"
      table={<DataTable headers={["Hour", "Sales", "Revenue"]} rows={r.by_hour.map((h) => [`${h.hour}:00`, h.transactions, peso(h.revenue_centavos)])} />}
    >
      <ColumnBars data={data} format={peso} axisFormat={pesoAxis} />
      {days.size > 1 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-bold">Day × hour</h3>
          <Heatmap cells={r.by_day_hour.map((c) => ({ day: c.day, hour: c.hour, value: c.revenue_centavos }))} format={peso} />
        </div>
      )}
    </ChartCard>
  );
}

function BundleTable({ r }: { r: DashboardReport }) {
  if (!r.bundles.length) return null;
  return (
    <ChartCard title="Bundle performance" subtitle="Discount given = what the same pastries cost separately minus what the customer paid">
      <div className="overflow-x-auto">
        <DataTable
          minWidth={680}
          headers={["Bundle", "Sold", "Revenue", "Gross profit", "Margin", "Discount vs separate", "Margin/piece vs singles"]}
          rows={r.bundles.map((b) => {
            const profit = b.revenue_centavos - b.cost_centavos;
            const discount = b.separate_value_centavos - b.revenue_centavos;
            return [
              `${b.name}${b.type === "mix_match" ? " (mix)" : ""}`, b.units, peso(b.revenue_centavos), peso(profit),
              b.revenue_centavos ? pct((profit / b.revenue_centavos) * 100) : "-",
              peso(discount),
              b.pieces ? `−${formatPeso(Math.round(discount / b.pieces))}` : "-",
            ];
          })}
        />
      </div>
    </ChartCard>
  );
}

function MixPicks({ r }: { r: DashboardReport }) {
  if (!r.mix_picks.length) return null;
  return (
    <ChartCard title="Most-picked in mix-and-match" table={<DataTable headers={["Pastry", "Picked"]} rows={r.mix_picks.map((m) => [m.name, m.units])} />}>
      <RankedBars data={r.mix_picks.map((m) => ({ label: m.name, value: m.units }))} format={(v) => `${v} picked`} axisFormat={String} color={SERIES_2} />
    </ChartCard>
  );
}

function ItemsDistribution({ r }: { r: DashboardReport }) {
  const data = r.items_distribution.map((d) => ({ label: d.items >= 10 ? "10+" : String(d.items), value: d.transactions }));
  return (
    <ChartCard title="Items per transaction" subtitle="How many pastries each customer bought"
      table={<DataTable headers={["Items", "Transactions"]} rows={data.map((d) => [d.label, d.value])} />}>
      <ColumnBars data={data} format={(v) => `${v} sales`} axisFormat={String} height={200} />
    </ChartCard>
  );
}

function SellThrough({ r }: { r: DashboardReport }) {
  if (!r.sell_through.length) return null;
  const multipleEvents = new Set(r.sell_through.map((s) => s.event_id)).size > 1;
  return (
    <ChartCard title="Sell-through" subtitle="Sold ÷ stocked (starting stock + restocks), and when each pastry ran out">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm tabular-nums">
          <thead className="text-left text-ink-soft">
            <tr>
              {multipleEvents && <th className="py-1 font-semibold">Event</th>}
              <th className="py-1 font-semibold">Pastry</th>
              <th className="py-1 text-right font-semibold">Sold / stocked</th>
              <th className="w-1/3 py-1 font-semibold"><span className="sr-only">Bar</span></th>
              <th className="py-1 text-right font-semibold">Sold out at</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-crust-dark">
            {r.sell_through.map((s) => (
              <tr key={`${s.event_id}-${s.product}`}>
                {multipleEvents && <td className="py-1.5">{s.event_name}</td>}
                <td className="py-1.5 font-semibold">{s.product}</td>
                <td className="py-1.5 text-right">{s.sold} / {s.stocked} · {s.rate != null ? `${Math.round(s.rate * 100)}%` : "-"}</td>
                <td className="py-1.5 pl-3">
                  <div className="h-2.5 rounded-full bg-crust" aria-hidden>
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, (s.rate ?? 0) * 100)}%`, background: "var(--color-series-1)" }} />
                  </div>
                </td>
                <td className="py-1.5 text-right">{s.sold_out_at ? <span className="font-semibold">✕ {formatTime(s.sold_out_at)}</span> : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

function StaffTable({ r }: { r: DashboardReport }) {
  return (
    <ChartCard title="Sales by staff" table={<DataTable headers={["Staff", "Sales", "Items", "Revenue"]} rows={r.by_staff.map((s) => [s.name, s.transactions, s.items, peso(s.revenue_centavos)])} />}>
      <RankedBars data={r.by_staff.map((s) => ({ label: s.name, value: s.revenue_centavos }))} format={peso} axisFormat={pesoAxis} />
    </ChartCard>
  );
}

function WasteAndDiscounts({ r }: { r: DashboardReport }) {
  const totalDiscount = r.discounts.reduce((s, d) => s + d.amount_centavos, 0);
  return (
    <figure className="card space-y-4 p-4">
      <div>
        <h2 className="font-bold">Waste and unsold stock (at cost)</h2>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-xl bg-cream p-2"><dt className="text-xs text-ink-soft">Waste</dt><dd className="font-bold tabular-nums">{peso(r.waste.waste_cost_centavos)}</dd></div>
          <div className="rounded-xl bg-cream p-2"><dt className="text-xs text-ink-soft">Unsold (closed events)</dt><dd className="font-bold tabular-nums">{peso(r.unsold.unsold_cost_centavos)}</dd></div>
          <div className="rounded-xl bg-cream p-2"><dt className="text-xs text-ink-soft">Staff meals</dt><dd className="font-bold tabular-nums">{peso(r.waste.staff_meal_cost_centavos)}</dd></div>
          <div className="rounded-xl bg-cream p-2"><dt className="text-xs text-ink-soft">Giveaways</dt><dd className="font-bold tabular-nums">{peso(r.waste.giveaway_cost_centavos)}</dd></div>
        </dl>
      </div>
      <div>
        <h2 className="font-bold">Discounts given: {peso(totalDiscount)}</h2>
        {r.discounts.length === 0 ? <p className="text-sm text-ink-soft">No discounts.</p> : (
          <DataTable headers={["Reason", "Sales", "Amount"]} rows={r.discounts.map((d) => [d.reason, d.transactions, peso(d.amount_centavos)])} />
        )}
      </div>
    </figure>
  );
}
