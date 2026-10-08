import { describe, expect, it } from "vitest";
import { linesCsv, manilaTimestamp, transactionsCsv, type LineRow, type TxnRow } from "./transactions";

const txn: TxnRow = {
  id: "t1", order_number: "T1-261010-0007", device_id: "d1", created_at: "2026-10-10T03:41:00Z", event_id: "e1", staff_id: "s1", client_created_at: "2026-10-10T03:40:05Z", synced_at: "2026-10-10T03:41:00Z",
  subtotal_centavos: 19000, discount_type: "percent", discount_value: 1000, discount_centavos: 1900, discount_reason: "Promo, weekend",
  total_centavos: 17100, payment_method: "cash", qr_reference: null, payment_status: "paid", payment_photo_path: null, cash_received_centavos: 20000, change_given_centavos: 2900,
  item_count: 2, has_bundle: true, status: "completed", void_reason: null, voided_at: null, flags: [],
  staff: { name: "Staff One" }, voided_by: null, events: { name: "Market" },
};

describe("exports", () => {
  it("timestamps are in Manila time", () => {
    expect(manilaTimestamp("2026-10-10T03:40:05Z")).toBe("2026-10-10 11:40:05");
  });

  it("transactions CSV has exact decimal money and escapes text", () => {
    const csv = transactionsCsv([txn]);
    expect(csv.split("\r\n")[1]).toContain('"Promo, weekend",171.00,cash,paid');
    expect(csv.split("\r\n")[1]).toMatch(/^t1,T1-261010-0007,2026-10-10 11:40:05,2026-10-10 11:41:00,/);
  });

  it("line CSV expands bundle components with net revenue and profit", () => {
    const lines: LineRow[] = [{
      id: "l1", transaction_id: "t1", position: 0, kind: "bundle", name_snapshot: "Breakfast Duo", quantity: 1,
      unit_price_centavos: 19000, line_total_centavos: 19000,
      transaction_line_components: [
        { quantity: 1, regular_unit_price_centavos: 9500, allocated_revenue_centavos: 8805, allocated_discount_centavos: 881, unit_cost_centavos: 3800, products: { name: "Butter Croissant" } },
        { quantity: 1, regular_unit_price_centavos: 11000, allocated_revenue_centavos: 10195, allocated_discount_centavos: 1019, unit_cost_centavos: 4500, products: { name: "Pain au Chocolat" } },
      ],
    }];
    const rows = linesCsv([txn], lines).trim().split("\r\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("Butter Croissant,1,95.00,88.05,8.81,79.24,38.00,38.00,41.24");
  });
});
