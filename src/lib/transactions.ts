import type { SupabaseClient } from "@supabase/supabase-js";
import { toCsv } from "./csv";
import { centavosToDecimalString } from "./money";
import { addDays, manilaDayStart, TZ } from "./time";

export type TxnFilters = {
  eventId?: string;
  from?: string; // YYYY-MM-DD (Manila)
  to?: string; // inclusive
  paymentMethod?: "cash" | "qr_ph";
  staffId?: string;
  status?: "completed" | "voided";
  hasBundle?: boolean;
  qrSearch?: string;
};

export type TxnRow = {
  id: string;
  event_id: string;
  staff_id: string;
  client_created_at: string;
  synced_at: string;
  subtotal_centavos: number;
  discount_type: "fixed" | "percent" | null;
  discount_value: number | null;
  discount_centavos: number;
  discount_reason: string | null;
  total_centavos: number;
  payment_method: "cash" | "qr_ph";
  qr_reference: string | null;
  cash_received_centavos: number | null;
  change_given_centavos: number | null;
  item_count: number;
  has_bundle: boolean;
  status: "completed" | "voided";
  void_reason: string | null;
  voided_at: string | null;
  flags: string[];
  staff: { name: string } | null;
  voided_by: { name: string } | null;
  events: { name: string } | null;
};

export const TXN_SELECT =
  "*, staff:staff!transactions_staff_id_fkey(name), voided_by:staff!transactions_voided_by_staff_id_fkey(name), events(name)";

export const LINES_SELECT =
  "id, position, kind, name_snapshot, quantity, unit_price_centavos, line_total_centavos, transaction_id, " +
  "transaction_line_components(quantity, regular_unit_price_centavos, allocated_revenue_centavos, allocated_discount_centavos, unit_cost_centavos, products(name))";

export type LineRow = {
  id: string;
  transaction_id: string;
  position: number;
  kind: "product" | "bundle";
  name_snapshot: string;
  quantity: number;
  unit_price_centavos: number;
  line_total_centavos: number;
  transaction_line_components: {
    quantity: number;
    regular_unit_price_centavos: number;
    allocated_revenue_centavos: number;
    allocated_discount_centavos: number;
    unit_cost_centavos: number;
    products: { name: string } | null;
  }[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyTxnFilters<Q extends { eq: any; gte: any; lt: any; ilike: any }>(query: Q, f: TxnFilters): Q {
  let q = query;
  if (f.eventId) q = q.eq("event_id", f.eventId);
  if (f.from) q = q.gte("client_created_at", manilaDayStart(f.from));
  if (f.to) q = q.lt("client_created_at", manilaDayStart(addDays(f.to, 1)));
  if (f.paymentMethod) q = q.eq("payment_method", f.paymentMethod);
  if (f.staffId) q = q.eq("staff_id", f.staffId);
  if (f.status) q = q.eq("status", f.status);
  if (f.hasBundle) q = q.eq("has_bundle", true);
  if (f.qrSearch?.trim()) q = q.ilike("qr_reference", `%${f.qrSearch.trim().replace(/[%_]/g, "")}%`);
  return q;
}

/** Fetches every matching transaction (paged under the hood) for exports. */
export async function fetchAllTransactions(supabase: SupabaseClient, f: TxnFilters, max = 20000): Promise<TxnRow[]> {
  const out: TxnRow[] = [];
  const page = 1000;
  for (let from = 0; from < max; from += page) {
    const { data, error } = await applyTxnFilters(
      supabase.from("transactions").select(TXN_SELECT).order("client_created_at", { ascending: true }),
      f,
    ).range(from, from + page - 1);
    if (error) throw error;
    out.push(...(data as TxnRow[]));
    if (!data || data.length < page) break;
  }
  return out;
}

export async function fetchLines(supabase: SupabaseClient, transactionIds: string[]): Promise<LineRow[]> {
  const out: LineRow[] = [];
  for (let i = 0; i < transactionIds.length; i += 200) {
    const { data, error } = await supabase
      .from("transaction_lines")
      .select(LINES_SELECT)
      .in("transaction_id", transactionIds.slice(i, i + 200))
      .order("position");
    if (error) throw error;
    out.push(...(data as unknown as LineRow[]));
  }
  return out;
}

const manilaStamp = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
/** "2026-10-10 11:40:05" in Manila time, spreadsheet-friendly */
export function manilaTimestamp(ts: string): string {
  return manilaStamp.format(new Date(ts)).replace(",", "");
}

const money = (c: number | null) => (c == null ? "" : centavosToDecimalString(c));

export function transactionsCsv(rows: TxnRow[]): string {
  return toCsv(
    ["transaction_id", "time_manila", "event", "staff", "status", "items", "has_bundle", "subtotal", "discount", "discount_reason",
      "total", "payment_method", "qr_reference", "cash_received", "change_given", "void_reason", "voided_by", "voided_at_manila", "synced_at_manila", "flags"],
    rows.map((t) => [
      t.id, manilaTimestamp(t.client_created_at), t.events?.name ?? "", t.staff?.name ?? "", t.status, t.item_count, t.has_bundle ? "yes" : "no",
      money(t.subtotal_centavos), money(t.discount_centavos), t.discount_reason ?? "", money(t.total_centavos), t.payment_method,
      t.qr_reference ?? "", money(t.cash_received_centavos), money(t.change_given_centavos), t.void_reason ?? "", t.voided_by?.name ?? "",
      t.voided_at ? manilaTimestamp(t.voided_at) : "", manilaTimestamp(t.synced_at), t.flags.join(" "),
    ]),
  );
}

/** One row per component handed over (bundle lines expand to their contents). */
export function linesCsv(rows: TxnRow[], lines: LineRow[]): string {
  const byTxn = new Map(rows.map((t) => [t.id, t]));
  const out: unknown[][] = [];
  for (const l of lines) {
    const t = byTxn.get(l.transaction_id);
    if (!t) continue;
    for (const c of l.transaction_line_components) {
      const net = c.allocated_revenue_centavos - c.allocated_discount_centavos;
      out.push([
        t.id, manilaTimestamp(t.client_created_at), t.events?.name ?? "", t.staff?.name ?? "", t.status, t.payment_method,
        l.kind, l.name_snapshot, l.quantity, money(l.unit_price_centavos), money(l.line_total_centavos),
        c.products?.name ?? "", c.quantity, money(c.regular_unit_price_centavos), money(c.allocated_revenue_centavos),
        money(c.allocated_discount_centavos), money(net), money(c.unit_cost_centavos), money(c.unit_cost_centavos * c.quantity),
        money(net - c.unit_cost_centavos * c.quantity),
      ]);
    }
  }
  return toCsv(
    ["transaction_id", "time_manila", "event", "staff", "status", "payment_method", "line_kind", "line_name", "line_qty", "line_unit_price",
      "line_total", "product", "product_qty", "regular_unit_price", "allocated_revenue", "allocated_discount", "net_revenue", "unit_cost",
      "total_cost", "gross_profit"],
    out,
  );
}
