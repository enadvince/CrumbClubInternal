import { describe, expect, it } from "vitest";
import { insights, pctChange, previousScope, resolveScope, type DashboardReport } from "./dashboard";

describe("scopes (Asia/Manila)", () => {
  it("today is Manila midnight to midnight", () => {
    const s = resolveScope("today", { today: "2026-10-10" });
    expect(s.from).toBe("2026-10-09T16:00:00.000Z");
    expect(s.to).toBe("2026-10-10T16:00:00.000Z");
  });
  it("week starts Monday", () => {
    // 2026-10-10 is a Saturday → week of Mon Oct 5
    const s = resolveScope("week", { today: "2026-10-10" });
    expect(s.from).toBe("2026-10-04T16:00:00.000Z");
    expect(s.to).toBe("2026-10-11T16:00:00.000Z");
  });
  it("month and custom ranges", () => {
    expect(resolveScope("month", { today: "2026-12-15" }).to).toBe("2026-12-31T16:00:00.000Z");
    const c = resolveScope("custom", { from: "2026-10-01", to: "2026-10-03" });
    expect(c.to).toBe("2026-10-03T16:00:00.000Z");
  });
  it("previous period has the same length", () => {
    const s = resolveScope("week", { today: "2026-10-10" });
    const p = previousScope(s, [])!;
    expect(p.to).toBe(s.from);
    expect(p.from).toBe("2026-09-27T16:00:00.000Z");
  });
  it("previous event is the one before by start date", () => {
    const events = [
      { id: "a", name: "A", starts_on: "2026-09-01", ends_on: "2026-09-01", status: "closed" },
      { id: "c", name: "C", starts_on: "2026-10-10", ends_on: "2026-10-10", status: "live" },
      { id: "b", name: "B", starts_on: "2026-09-20", ends_on: "2026-09-21", status: "closed" },
    ];
    expect(previousScope({ from: null, to: null, eventId: "c", label: "C" }, events)?.eventId).toBe("b");
    expect(previousScope({ from: null, to: null, eventId: "a", label: "A" }, events)).toBeNull();
  });
  it("pct change", () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(1, 0)).toBeNull();
  });
});

const base: DashboardReport = {
  kpis: { revenue_centavos: 100000, cost_centavos: 40000, transactions: 10, items: 20, cash_centavos: 60000, qr_centavos: 40000, bundle_revenue_centavos: 65000, transactions_with_bundle: 1, discount_centavos: 0, first_sale_at: null, last_sale_at: null },
  by_product: [], mix_picks: [], items_distribution: [], by_staff: [], discounts: [], by_day_hour: [],
  bundles: [{ bundle_id: "b", name: "Box of 6", type: "fixed", units: 2, pieces: 12, line_total_centavos: 130000, revenue_centavos: 130000, cost_centavos: 60000, separate_value_centavos: 144000 }],
  by_hour: [{ hour: 10, transactions: 6, revenue_centavos: 70000, items: 12 }, { hour: 11, transactions: 4, revenue_centavos: 30000, items: 8 }],
  sell_through: [{ event_id: "e", event_name: "Market", event_starts_on: "2026-10-10", event_status: "live", product: "Ube croissant", stocked: 24, sold: 24, sold_out_at: "2026-10-10T03:40:00Z", rate: 1, first_sale_at: "2026-10-10T01:00:00Z" }],
  waste: { waste_cost_centavos: 0, staff_meal_cost_centavos: 0, giveaway_cost_centavos: 0, waste_units: 0 },
  unsold: { unsold_cost_centavos: 0, unsold_units: 0 },
  sync: { last_synced_at: null, device_last_seen_at: null, device_unsynced_count: null },
};

describe("insights", () => {
  it("produces the example insights from the spec", () => {
    const lines = insights(base);
    expect(lines[0]).toBe("Ube croissant sold out at 11:40 AM, 2h 40m after the first sale — consider bringing more.");
    expect(lines).toContain("Box of 6 earns ₱11.67 less margin per piece than single sales (2 sold).");
    expect(lines.some((l) => l.startsWith("Busiest hour: 10am–11am"))).toBe(true);
  });
  it("compares with the previous period", () => {
    const prev = { ...base, kpis: { ...base.kpis, revenue_centavos: 80000 } };
    expect(insights(base, prev, "last week")).toContain("Revenue is up 25% vs last week.");
  });
  it("says nothing without sales", () => {
    expect(insights({ ...base, kpis: { ...base.kpis, transactions: 0 } })).toEqual([]);
  });
});
