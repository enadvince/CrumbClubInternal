import { describe, expect, it } from "vitest";
import { denominationTotal, expectedCash, provisionalLabel, varianceNeedsApproval, DEFAULT_VARIANCE_THRESHOLD } from "./shift";

describe("cash drawer maths", () => {
  it("counts the drawer by denomination, in centavos", () => {
    expect(denominationTotal({ b1000: 2, b500: 1, b20: 3, c20: 2, c5: 1, c1: 4 })).toBe(200000 + 50000 + 6000 + 4000 + 500 + 400);
    expect(denominationTotal(null)).toBe(0);
    expect(() => denominationTotal({ b100: -1 })).toThrow();
    expect(() => denominationTotal({ b100: 1.5 })).toThrow();
  });

  it("expected cash = float + cash sales - cash refunds + cash in - cash out", () => {
    expect(expectedCash({ openingFloat: 100000, cashSales: 84000, cashRefunds: 9500, cashIn: 10000, cashOut: 5000 })).toBe(179500);
  });

  it("needs an owner PIN only when the absolute variance is over the threshold (default ₱50)", () => {
    expect(DEFAULT_VARIANCE_THRESHOLD).toBe(5000);
    expect(varianceNeedsApproval(5000, 5000)).toBe(false);
    expect(varianceNeedsApproval(-5000, 5000)).toBe(false);
    expect(varianceNeedsApproval(5001, 5000)).toBe(true);
    expect(varianceNeedsApproval(-10000, 5000)).toBe(true);
  });

  it("labels a report provisional until everything for the shift has synced", () => {
    expect(provisionalLabel({ orders: 3, other: 1 })).toBe("Provisional: 3 orders not yet synced");
    expect(provisionalLabel({ orders: 1, other: 0 })).toBe("Provisional: 1 order not yet synced");
    expect(provisionalLabel({ orders: 0, other: 2 })).toBe("Provisional: 2 changes not yet synced");
    expect(provisionalLabel({ orders: 0, other: 0 })).toBeNull();
  });
});
