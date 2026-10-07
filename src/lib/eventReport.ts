import type { EventRow } from "./types";

export type EventReport = {
  event: EventRow;
  totals: {
    transactions: number; voided: number; voided_total_centavos: number; revenue_centavos: number; subtotal_centavos: number;
    discount_centavos: number; items: number; cash_centavos: number; qr_centavos: number; qr_count: number;
    cost_centavos: number; flagged: number; last_synced_at: string | null;
  };
  cash: {
    opening_float_centavos: number; cash_sales_centavos: number; expected_cash_centavos: number;
    counted_cash_centavos: number | null; variance_centavos: number | null; notes: string | null; closed_at: string | null;
  };
  products: {
    event_product_id: string; product_id: string; name: string; price_centavos: number; cost_centavos: number;
    starting_stock: number; current_stock: number; sold_out_at: string | null; closing_stock: number | null; closing_unit_cost: number | null;
    restocked: number; waste: number; staff_meal: number; giveaway: number; correction: number; waste_cost_centavos: number;
    sold: number; revenue_centavos: number; cost_centavos_sold: number; sold_in_bundles: number;
  }[];
  bundles: { bundle_id: string; name: string; units: number; revenue_centavos: number }[];
  qr_payments: { id: string; time: string; reference: string; amount_centavos: number; flags: string[] }[];
  device: { last_seen_at: string | null; unsynced_count: number | null; oldest_unsynced_at: string | null } | null;
};

/** Leftover stock the event ends with (closing snapshot once closed, live stock before). */
export function leftover(p: EventReport["products"][number]): number {
  return Math.max(0, p.closing_stock ?? p.current_stock);
}

export function leftoverUnitCost(p: EventReport["products"][number]): number {
  return p.closing_unit_cost ?? p.cost_centavos;
}
