import { formatPeso } from "./money";
import { addDays, formatTime, manilaDate, manilaDayStart } from "./time";

export type DashboardReport = {
  kpis: {
    revenue_centavos: number; cost_centavos: number; transactions: number; items: number; cash_centavos: number; qr_centavos: number;
    bundle_revenue_centavos: number; transactions_with_bundle: number; discount_centavos: number;
    first_sale_at: string | null; last_sale_at: string | null;
  };
  by_product: { product_id: string; name: string; units: number; single_units: number | null; bundle_units: number | null; revenue_centavos: number; cost_centavos: number }[];
  bundles: { bundle_id: string; name: string; type: "fixed" | "mix_match"; units: number; pieces: number; line_total_centavos: number; revenue_centavos: number; cost_centavos: number; separate_value_centavos: number }[];
  mix_picks: { name: string; units: number }[];
  by_hour: { hour: number; transactions: number; revenue_centavos: number; items: number }[];
  by_day_hour: { day: string; hour: number; transactions: number; revenue_centavos: number }[];
  items_distribution: { items: number; transactions: number }[];
  by_staff: { staff_id: string; name: string; transactions: number; revenue_centavos: number; items: number }[];
  discounts: { reason: string; transactions: number; amount_centavos: number }[];
  sell_through: { event_id: string; event_name: string; event_starts_on: string; event_status: string; product: string; stocked: number; sold: number; sold_out_at: string | null; rate: number | null; first_sale_at: string | null }[];
  waste: { waste_cost_centavos: number; staff_meal_cost_centavos: number; giveaway_cost_centavos: number; waste_units: number };
  unsold: { unsold_cost_centavos: number; unsold_units: number };
  sync: { last_synced_at: string | null; device_last_seen_at: string | null; device_unsynced_count: number | null };
};

export type Preset = "today" | "event" | "date" | "week" | "month" | "custom";
export type Scope = { from: string | null; to: string | null; eventId: string | null; label: string };
export type EventLite = { id: string; name: string; starts_on: string; ends_on: string; status: string };

/** Monday-start week, in Manila calendar dates. */
function weekStart(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** Resolves a filter preset into a query scope. Date ranges are [from, to) instants at Manila midnight. */
export function resolveScope(
  preset: Preset,
  opts: { today?: string; date?: string; from?: string; to?: string; event?: EventLite | null } = {},
): Scope {
  const today = opts.today ?? manilaDate();
  const range = (fromDate: string, toExclusive: string, label: string): Scope => ({
    from: manilaDayStart(fromDate), to: manilaDayStart(toExclusive), eventId: null, label,
  });
  switch (preset) {
    case "today": return range(today, addDays(today, 1), "Today");
    case "date": { const d = opts.date ?? today; return range(d, addDays(d, 1), d); }
    case "week": { const s = weekStart(today); return range(s, addDays(s, 7), "This week"); }
    case "month": { const s = `${today.slice(0, 7)}-01`; const next = new Date(`${s}T12:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); return range(s, next.toISOString().slice(0, 10), "This month"); }
    case "custom": { const f = opts.from ?? today; const t = opts.to ?? f; return range(f, addDays(t, 1), `${f} – ${t}`); }
    case "event": return opts.event ? { from: null, to: null, eventId: opts.event.id, label: opts.event.name } : range(today, addDays(today, 1), "Today");
  }
}

/** The comparison scope: the previous event, or the same-length period immediately before. */
export function previousScope(scope: Scope, events: EventLite[]): Scope | null {
  if (scope.eventId) {
    const sorted = [...events].sort((a, b) => b.starts_on.localeCompare(a.starts_on));
    const i = sorted.findIndex((e) => e.id === scope.eventId);
    const prev = i >= 0 ? sorted[i + 1] : undefined;
    return prev ? { from: null, to: null, eventId: prev.id, label: prev.name } : null;
  }
  if (!scope.from || !scope.to) return null;
  const len = new Date(scope.to).getTime() - new Date(scope.from).getTime();
  return { from: new Date(new Date(scope.from).getTime() - len).toISOString(), to: scope.from, eventId: null, label: "previous period" };
}

export function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function duration(ms: number): string {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

/** Short, data-backed observations. Only produced when the data supports them. */
export function insights(r: DashboardReport, previous?: DashboardReport | null, previousLabel?: string): string[] {
  const out: string[] = [];
  const k = r.kpis;
  if (k.transactions === 0) return out;

  for (const s of [...r.sell_through].filter((s) => s.sold_out_at).sort((a, b) => a.sold_out_at!.localeCompare(b.sold_out_at!))) {
    const after = s.first_sale_at ? `, ${duration(new Date(s.sold_out_at!).getTime() - new Date(s.first_sale_at).getTime())} after the first sale` : "";
    out.push(`${s.product} sold out at ${formatTime(s.sold_out_at!)}${after} — consider bringing more.`);
  }

  // The bundle that gives up the most margin per piece.
  const worstBundle = r.bundles
    .filter((b) => b.pieces > 0)
    .map((b) => ({ b, less: (b.separate_value_centavos - b.revenue_centavos) / b.pieces }))
    .sort((x, y) => y.less - x.less)[0];
  if (worstBundle && worstBundle.less >= 100) {
    out.push(`${worstBundle.b.name} earns ${formatPeso(Math.round(worstBundle.less))} less margin per piece than single sales (${worstBundle.b.units} sold).`);
  }

  // The two slowest sellers at closed events.
  r.sell_through
    .filter((s) => s.event_status === "closed" && s.rate != null && s.rate < 0.5 && s.stocked >= 10)
    .sort((a, b) => a.rate! - b.rate!)
    .slice(0, 2)
    .forEach((s) => out.push(`Only ${Math.round(s.rate! * 100)}% of ${s.product} sold at ${s.event_name} — consider bringing fewer.`));

  const peak = [...r.by_hour].sort((a, b) => b.revenue_centavos - a.revenue_centavos)[0];
  if (peak && r.by_hour.length > 1) {
    const h = (n: number) => `${((n + 11) % 12) + 1}${n < 12 ? "am" : "pm"}`;
    out.push(`Busiest hour: ${h(peak.hour)}–${h((peak.hour + 1) % 24)} with ${formatPeso(peak.revenue_centavos, { trimZeros: true })} from ${peak.transactions} sales.`);
  }

  if (previous && previous.kpis.revenue_centavos > 0) {
    const ch = pctChange(k.revenue_centavos, previous.kpis.revenue_centavos)!;
    if (Math.abs(ch) >= 5) out.push(`Revenue is ${ch > 0 ? "up" : "down"} ${Math.abs(ch).toFixed(0)}% vs ${previousLabel ?? "the previous period"}.`);
  }

  const wasteTotal = r.waste.waste_cost_centavos + r.unsold.unsold_cost_centavos;
  if (k.cost_centavos > 0 && wasteTotal / k.cost_centavos >= 0.15) {
    out.push(`Waste and unsold stock cost ${formatPeso(wasteTotal, { trimZeros: true })} — ${Math.round((wasteTotal / k.cost_centavos) * 100)}% of the cost of what sold.`);
  }
  return out.slice(0, 6);
}
