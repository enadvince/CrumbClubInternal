import { describe, expect, it } from "vitest";
import { allocate } from "./allocate";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

describe("allocate (largest remainder)", () => {
  it("splits proportionally", () => {
    expect(allocate(1000, [1, 1])).toEqual([500, 500]);
    expect(allocate(19000, [9500, 11000])).toEqual([8805, 10195]); // Breakfast Duo: 19000 × 9500/20500 = 8804.88
  });

  it("handles centavo remainders exactly", () => {
    // ₱100.00 across three equal items → 33.34 + 33.33 + 33.33
    const parts = allocate(10000, [1, 1, 1]);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(parts.reduce((a, b) => a + b)).toBe(10000);
  });

  it("gives leftovers to the largest fractional parts", () => {
    // 10 × [1,2,3]/6 = 1.67, 3.33, 5 → floors 1,3,5 (sum 9); largest remainder is index 0
    expect(allocate(10, [1, 2, 3])).toEqual([2, 3, 5]);
  });

  it("is deterministic on ties (earlier index wins)", () => {
    expect(allocate(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocate(2, [5, 5, 5])).toEqual([1, 1, 0]);
  });

  it("splits evenly when all weights are zero", () => {
    expect(allocate(100, [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it("zero-weight parts get nothing when others have weight", () => {
    expect(allocate(500, [0, 3, 0, 2])).toEqual([0, 300, 0, 200]);
  });

  it("zero total", () => {
    expect(allocate(0, [3, 4])).toEqual([0, 0]);
    expect(allocate(0, [])).toEqual([]);
  });

  it("rejects bad input", () => {
    expect(() => allocate(10.5, [1])).toThrow();
    expect(() => allocate(-1, [1])).toThrow();
    expect(() => allocate(10, [1.5])).toThrow();
    expect(() => allocate(10, [])).toThrow();
  });

  it("property: always sums exactly, never negative, within 1 of exact share", () => {
    const rand = rng(42);
    for (let n = 0; n < 5000; n++) {
      const count = 1 + Math.floor(rand() * 8);
      const weights = Array.from({ length: count }, () => Math.floor(rand() * 20000));
      const total = Math.floor(rand() * 2_000_000);
      const parts = allocate(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      const W = weights.reduce((a, b) => a + b, 0) || count;
      parts.forEach((p, i) => {
        expect(p).toBeGreaterThanOrEqual(0);
        const exact = (total * (W === count && weights.every((w) => w === 0) ? 1 : weights[i])) / W;
        expect(Math.abs(p - exact)).toBeLessThan(1);
      });
    }
  });

  it("large amounts stay exact", () => {
    const parts = allocate(999_999_999_99, [123_456, 654_321, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(999_999_999_99);
  });
});
