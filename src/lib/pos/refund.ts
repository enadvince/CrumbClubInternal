import type { Centavos } from "../money";
import type { SalePayloadLine } from "./types";

/**
 * Amount for refunding k more units of a line, given what was refunded before.
 * Uses a cumulative floor so partial refunds always add up exactly to the line's
 * net total. Must match public._refund_amount() on the server.
 */
export function refundAmount(net: Centavos, qty: number, prevQty: number, prevAmount: Centavos, k: number): Centavos {
  if (k <= 0) return 0;
  if (prevQty + k >= qty) return net - prevAmount;
  return Math.floor((net * (prevQty + k)) / qty) - prevAmount;
}

/** What the customer actually paid for a line: its total minus its share of the order discount. */
export function lineNet(line: SalePayloadLine): Centavos {
  return line.line_total_centavos - line.components.reduce((s, c) => s + c.allocated_discount_centavos, 0);
}

export type RefundableLine = {
  lineId: string;
  name: string;
  soldQty: number;
  refundedQty: number;
  remainingQty: number;
  net: Centavos;
  refundedAmount: Centavos;
};

export function refundableLines(
  lines: readonly SalePayloadLine[],
  refunded: Record<string, { qty: number; amount: Centavos }> = {},
): RefundableLine[] {
  return lines.map((l) => {
    const r = refunded[l.id] ?? { qty: 0, amount: 0 };
    return {
      lineId: l.id, name: l.name_snapshot, soldQty: l.quantity, refundedQty: r.qty,
      remainingQty: l.quantity - r.qty, net: lineNet(l), refundedAmount: r.amount,
    };
  });
}

/** Stock that comes back when k units of a line are refunded (bundles expand to components). */
export function refundStockEffects(line: SalePayloadLine, k: number): { eventProductId: string; delta: number }[] {
  return line.components
    .map((c) => ({ eventProductId: c.event_product_id, delta: Math.floor((c.quantity * k) / line.quantity) }))
    .filter((e) => e.delta > 0);
}
