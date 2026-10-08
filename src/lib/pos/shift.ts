import type { Centavos } from "../money";
import type { Denominations, LocalDrawerMovement, LocalRefund, LocalSale, LocalShift } from "../offline/db";

/** Philippine peso notes and coins counted in the drawer. ₱20 exists as both. */
export const DENOMINATIONS: { key: string; label: string; centavos: Centavos; kind: "bill" | "coin" }[] = [
  { key: "b1000", label: "₱1000", centavos: 100000, kind: "bill" },
  { key: "b500", label: "₱500", centavos: 50000, kind: "bill" },
  { key: "b200", label: "₱200", centavos: 20000, kind: "bill" },
  { key: "b100", label: "₱100", centavos: 10000, kind: "bill" },
  { key: "b50", label: "₱50", centavos: 5000, kind: "bill" },
  { key: "b20", label: "₱20", centavos: 2000, kind: "bill" },
  { key: "c20", label: "₱20", centavos: 2000, kind: "coin" },
  { key: "c10", label: "₱10", centavos: 1000, kind: "coin" },
  { key: "c5", label: "₱5", centavos: 500, kind: "coin" },
  { key: "c1", label: "₱1", centavos: 100, kind: "coin" },
];

export function denominationTotal(denoms: Denominations | null | undefined): Centavos {
  if (!denoms) return 0;
  let total = 0;
  for (const d of DENOMINATIONS) {
    const n = denoms[d.key] ?? 0;
    if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid count for ${d.label}`);
    total += n * d.centavos;
  }
  return total;
}

/** Expected cash = opening float + cash sales − cash refunds + cash in − cash out. Must match _shift_expected_cash(). */
export function expectedCash(a: { openingFloat: Centavos; cashSales: Centavos; cashRefunds: Centavos; cashIn: Centavos; cashOut: Centavos }): Centavos {
  return a.openingFloat + a.cashSales - a.cashRefunds + a.cashIn - a.cashOut;
}

/** Closing needs an owner PIN and a note when the absolute variance is over the threshold. */
export function varianceNeedsApproval(variance: Centavos, threshold: Centavos): boolean {
  return Math.abs(variance) > threshold;
}

export const DEFAULT_VARIANCE_THRESHOLD: Centavos = 5000;

export type ShiftReport = {
  shift: LocalShift;
  orders: number;
  grossSales: Centavos;
  discounts: Centavos;
  voids: { count: number; total: Centavos };
  refunds: { count: number; total: Centavos; cash: Centavos };
  netSales: Centavos;
  byMethod: { cash: Centavos; qr: Centavos };
  qrAwaiting: { count: number; total: Centavos };
  drawer: LocalDrawerMovement[];
  cashIn: Centavos;
  cashOut: Centavos;
  expectedCash: Centavos;
  countedCash: Centavos | null;
  variance: Centavos | null;
  topItems: { name: string; quantity: number; revenue: Centavos }[];
  cashiers: string[];
  /** Entries for this shift not on the server yet: the report is provisional until 0 */
  unsynced: { orders: number; other: number };
};

/** The shift report from this tablet's data. Same figures as shift_report() on the server. */
export function buildShiftReport(
  shift: LocalShift,
  data: { sales: readonly LocalSale[]; refunds: readonly LocalRefund[]; drawer: readonly LocalDrawerMovement[]; unsynced?: { orders: number; other: number } },
): ShiftReport {
  const sales = data.sales.filter((s) => s.shiftId === shift.id);
  const completed = sales.filter((s) => s.status === "completed");
  const voided = sales.filter((s) => s.status === "voided");
  const refunds = data.refunds.filter((r) => r.shiftId === shift.id);
  const drawer = data.drawer.filter((m) => m.shiftId === shift.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const sum = <T,>(xs: readonly T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

  const cashSales = sum(completed.filter((s) => s.paymentMethod === "cash"), (s) => s.total);
  const qrSales = sum(completed.filter((s) => s.paymentMethod === "qr_ph"), (s) => s.total);
  const refundTotal = sum(refunds, (r) => r.amount);
  const cashRefunds = sum(refunds.filter((r) => r.method === "cash"), (r) => r.amount);
  const cashIn = sum(drawer.filter((m) => m.kind === "cash_in"), (m) => m.amount);
  const cashOut = sum(drawer.filter((m) => m.kind === "cash_out"), (m) => m.amount);
  const expected = expectedCash({ openingFloat: shift.openingFloat, cashSales, cashRefunds, cashIn, cashOut });
  const awaiting = completed.filter((s) => s.paymentMethod === "qr_ph" && s.paymentStatus !== "verified");

  const items = new Map<string, { quantity: number; revenue: number }>();
  for (const s of completed) {
    for (const l of s.payload.lines) {
      const it = items.get(l.name_snapshot) ?? { quantity: 0, revenue: 0 };
      it.quantity += l.quantity;
      it.revenue += l.line_total_centavos;
      items.set(l.name_snapshot, it);
    }
  }
  const topItems = [...items.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
    .slice(0, 10);

  return {
    shift,
    orders: completed.length,
    grossSales: sum(completed, (s) => s.payload.subtotal_centavos),
    discounts: sum(completed, (s) => s.payload.discount_centavos),
    voids: { count: voided.length, total: sum(voided, (s) => s.total) },
    refunds: { count: refunds.length, total: refundTotal, cash: cashRefunds },
    netSales: sum(completed, (s) => s.total) - refundTotal,
    byMethod: { cash: cashSales, qr: qrSales },
    qrAwaiting: { count: awaiting.length, total: sum(awaiting, (s) => s.total) },
    drawer,
    cashIn,
    cashOut,
    expectedCash: expected,
    countedCash: shift.countedCash ?? null,
    variance: shift.countedCash == null ? null : shift.countedCash - expected,
    topItems,
    cashiers: [...new Set(sales.map((s) => s.staffName))].sort(),
    unsynced: data.unsynced ?? { orders: 0, other: 0 },
  };
}

/** "Provisional: 3 orders not yet synced", or null once everything for the shift is on the server. */
export function provisionalLabel(unsynced: { orders: number; other: number }): string | null {
  if (unsynced.orders > 0) return `Provisional: ${unsynced.orders} order${unsynced.orders === 1 ? "" : "s"} not yet synced`;
  if (unsynced.other > 0) return `Provisional: ${unsynced.other} change${unsynced.other === 1 ? "" : "s"} not yet synced`;
  return null;
}

/** shift_report() JSON from the server, as returned to owner pages. */
export type ServerShiftReport = {
  shift: {
    id: string; event_id: string; status: "open" | "closed"; opened_at: string; opening_float_centavos: number; opening_denoms: Denominations | null;
    closed_at: string | null; counted_cash_centavos: number | null; counted_denoms: Denominations | null; variance_note: string | null;
    expected_cash_device_centavos: number | null; close_note: string | null; device_id: string | null; device_code: string | null;
    event_name: string | null; opened_by: string | null; closed_by: string | null; approved_by: string | null;
  };
  orders: number; gross_sales_centavos: number; discounts_centavos: number;
  voids: { count: number; total_centavos: number };
  refunds: { count: number; total_centavos: number; cash_centavos: number };
  net_sales_centavos: number;
  by_method: { cash_centavos: number; qr_centavos: number };
  qr_awaiting: { count: number; total_centavos: number };
  drawer: { id: string; kind: "cash_in" | "cash_out"; amount_centavos: number; reason: string; at: string; staff: string | null; approved_by: string | null }[];
  expected_cash_centavos: number; counted_cash_centavos: number | null; variance_centavos: number | null;
  top_items: { name: string; quantity: number; revenue_centavos: number }[];
  cashiers: string[];
};

/** Maps the server's report into the same shape the tablet builds, so one view shows both. */
export function fromServerShiftReport(r: ServerShiftReport): ShiftReport {
  const s = r.shift;
  return {
    shift: {
      id: s.id, eventId: s.event_id, deviceId: s.device_id ?? "", status: s.status, openedAt: s.opened_at,
      openedByStaffId: "", openedByName: s.opened_by ?? "", openingFloat: s.opening_float_centavos, openingDenoms: s.opening_denoms,
      closedAt: s.closed_at ?? undefined, closedByName: s.closed_by ?? undefined, countedCash: s.counted_cash_centavos ?? undefined,
      countedDenoms: s.counted_denoms, varianceNote: s.variance_note ?? s.close_note, approvedByName: s.approved_by,
    },
    orders: r.orders,
    grossSales: r.gross_sales_centavos,
    discounts: r.discounts_centavos,
    voids: { count: r.voids.count, total: r.voids.total_centavos },
    refunds: { count: r.refunds.count, total: r.refunds.total_centavos, cash: r.refunds.cash_centavos },
    netSales: r.net_sales_centavos,
    byMethod: { cash: r.by_method.cash_centavos, qr: r.by_method.qr_centavos },
    qrAwaiting: { count: r.qr_awaiting.count, total: r.qr_awaiting.total_centavos },
    drawer: r.drawer.map((m) => ({
      id: m.id, shiftId: s.id, kind: m.kind, amount: m.amount_centavos, reason: m.reason, staffId: "", staffName: m.staff ?? "",
      approvedByStaffId: null, createdAt: m.at,
    })),
    cashIn: r.drawer.filter((m) => m.kind === "cash_in").reduce((a, m) => a + m.amount_centavos, 0),
    cashOut: r.drawer.filter((m) => m.kind === "cash_out").reduce((a, m) => a + m.amount_centavos, 0),
    expectedCash: r.expected_cash_centavos,
    countedCash: r.counted_cash_centavos,
    variance: r.variance_centavos,
    topItems: r.top_items.map((i) => ({ name: i.name, quantity: Number(i.quantity), revenue: Number(i.revenue_centavos) })),
    cashiers: [...r.cashiers].sort(),
    unsynced: { orders: 0, other: 0 },
  };
}
