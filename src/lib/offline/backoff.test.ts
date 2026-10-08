import { describe, expect, it } from "vitest";
import { BACKOFF_CAP_MS, backoffDelay, baseBackoff } from "./backoff";

describe("retry backoff", () => {
  it("follows 2s, 4s, 8s, 16s, 32s, then every 60s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(baseBackoff)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(baseBackoff(0)).toBe(0);
  });

  it("adds at most 20% jitter either way", () => {
    expect(backoffDelay(1, () => 0)).toBe(1600);
    expect(backoffDelay(1, () => 0.5)).toBe(2000);
    expect(backoffDelay(1, () => 0.999999)).toBe(2400);
    for (let i = 0; i < 200; i++) {
      const d = backoffDelay(6);
      expect(d).toBeGreaterThanOrEqual(48_000);
      expect(d).toBeLessThanOrEqual(72_000);
    }
  });

  it("never waits more than 5 minutes", () => {
    for (let n = 1; n < 100; n++) expect(backoffDelay(n, () => 0.999999)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
  });
});
