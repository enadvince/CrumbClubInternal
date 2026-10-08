import { describe, expect, it } from "vitest";
import { uuidv7, uuidv7Time } from "./uuid";

describe("uuidv7", () => {
  it("is a valid version 7, RFC 4122 variant UUID", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("encodes the creation time and sorts by it", () => {
    const t = Date.UTC(2026, 9, 8, 4, 30, 0, 123);
    expect(uuidv7Time(uuidv7(t))).toBe(t);
    const ids = [t + 2, t, t + 1].map((ms) => uuidv7(ms));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("is unique across many ids minted in the same millisecond", () => {
    const t = Date.now();
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(t)));
    expect(ids.size).toBe(5000);
  });
});
