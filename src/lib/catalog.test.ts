import { describe, expect, it } from "vitest";
import { fixedBundleEconomics, mixBundleEconomics, type CatalogProduct } from "./catalog";

const products = new Map<string, CatalogProduct>([
  ["ube", { id: "ube", name: "Ube", price: 12000, cost: 5000 }],
  ["butter", { id: "butter", name: "Butter", price: 9500, cost: 3800 }],
  ["almond", { id: "almond", name: "Almond", price: 13000, cost: 5500 }],
]);

describe("bundle economics", () => {
  it("fixed bundle vs separate", () => {
    const e = fixedBundleEconomics(65000, [{ productId: "ube", quantity: 6 }], products)!;
    expect(e.separatePrice).toBe(72000);
    expect(e.cost).toBe(30000);
    expect(e.discount).toBe(7000);
    expect(e.bundleMargin).toBe(35000);
    expect(e.separateMargin).toBe(42000);
    expect(e.separateMarginPerPiece - e.bundleMarginPerPiece).toBeCloseTo(7000 / 6);
  });

  it("mix bundle best/worst margins", () => {
    const e = mixBundleEconomics(60000, 6, ["ube", "butter", "almond"], products)!;
    expect(e.best.cost).toBe(3800 * 6);
    expect(e.worst.cost).toBe(5500 * 6);
    expect(e.worst.bundleMargin).toBe(60000 - 33000);
  });

  it("handles empty input", () => {
    expect(fixedBundleEconomics(100, [], products)).toBeNull();
    expect(mixBundleEconomics(100, 3, [], products)).toBeNull();
  });
});
