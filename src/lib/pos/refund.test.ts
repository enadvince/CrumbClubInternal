import { describe, expect, it } from "vitest";
import { lineNet, refundAmount, refundStockEffects, refundableLines } from "./refund";
import type { SalePayloadLine } from "./types";

const line = (over: Partial<SalePayloadLine> = {}): SalePayloadLine => ({
  id: "l1", kind: "bundle", product_id: null, event_product_id: null, bundle_id: "b", event_bundle_id: "eb",
  name_snapshot: "Breakfast Duo", quantity: 3, unit_price_centavos: 19000, line_total_centavos: 57000,
  components: [
    { event_product_id: "ep-butter", product_id: "p1", quantity: 3, regular_unit_price_centavos: 9500, allocated_revenue_centavos: 26400, allocated_discount_centavos: 1000, unit_cost_centavos: 3800 },
    { event_product_id: "ep-choc", product_id: "p2", quantity: 3, regular_unit_price_centavos: 11000, allocated_revenue_centavos: 30600, allocated_discount_centavos: 1001, unit_cost_centavos: 4500 },
  ],
  ...over,
});

describe("refund amounts", () => {
  it("partial refunds add up exactly to what was paid", () => {
    const net = lineNet(line());
    expect(net).toBe(57000 - 2001);
    const a = refundAmount(net, 3, 0, 0, 1);
    const b = refundAmount(net, 3, 1, a, 1);
    const c = refundAmount(net, 3, 2, a + b, 1);
    expect(a + b + c).toBe(net);
    expect([a, b, c]).toEqual([18333, 18333, 18333]);
    expect(refundAmount(1000, 3, 0, 0, 2) + refundAmount(1000, 3, 2, 666, 1)).toBe(1000);
  });

  it("returns bundle components to stock in proportion", () => {
    expect(refundStockEffects(line(), 2)).toEqual([{ eventProductId: "ep-butter", delta: 2 }, { eventProductId: "ep-choc", delta: 2 }]);
  });

  it("knows how much of each line is left to refund", () => {
    expect(refundableLines([line()], { l1: { qty: 1, amount: 18333 } })[0]).toMatchObject({ remainingQty: 2, refundedAmount: 18333 });
  });
});
