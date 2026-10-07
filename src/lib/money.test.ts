import { describe, expect, it } from "vitest";
import { formatPeso, parsePeso, percentOf, parsePercent, sumCentavos, centavosToDecimalString, marginPercent } from "./money";

describe("money", () => {
  it("formats centavos as pesos", () => {
    expect(formatPeso(123450)).toBe("₱1,234.50");
    expect(formatPeso(9500, { trimZeros: true })).toBe("₱95");
    expect(formatPeso(9550, { trimZeros: true })).toBe("₱95.50");
    expect(formatPeso(5)).toBe("₱0.05");
    expect(formatPeso(-500)).toBe("−₱5.00");
    expect(formatPeso(500, { sign: true })).toBe("+₱5.00");
  });

  it("parses typed amounts without floating point", () => {
    expect(parsePeso("1,234.5")).toBe(123450);
    expect(parsePeso("₱100")).toBe(10000);
    expect(parsePeso("0.29")).toBe(29); // 0.29 * 100 = 28.999999999999996 in floats
    expect(parsePeso("1.005")).toBeNull();
    expect(parsePeso("abc")).toBeNull();
    expect(parsePeso("")).toBeNull();
    expect(parsePeso("-5")).toBeNull();
  });

  it("classic float traps stay exact", () => {
    // 0.1 + 0.2 !== 0.3 in floats; in centavos it's exact
    expect(sumCentavos([parsePeso("0.1")!, parsePeso("0.2")!])).toBe(parsePeso("0.3"));
    let total = 0;
    for (let i = 0; i < 1000; i++) total += parsePeso("19.99")!;
    expect(total).toBe(1999000);
  });

  it("computes percentages half-up in integers", () => {
    expect(percentOf(10000, 1000)).toBe(1000); // 10% of ₱100
    expect(percentOf(9500, 1050)).toBe(998); // 997.5 → 998
    expect(percentOf(333, 3333)).toBe(111); // 110.99 → 111
    expect(percentOf(1, 5000)).toBe(1); // 0.5 → 1
  });

  it("parses percentages to basis points", () => {
    expect(parsePercent("10")).toBe(1000);
    expect(parsePercent("12.5")).toBe(1250);
    expect(parsePercent("100")).toBe(10000);
    expect(parsePercent("101")).toBeNull();
    expect(parsePercent("1.234")).toBeNull();
  });

  it("rejects non-integer centavos", () => {
    expect(() => sumCentavos([1.5])).toThrow();
    expect(() => formatPeso(0.1)).toThrow();
  });

  it("CSV decimal strings", () => {
    expect(centavosToDecimalString(123405)).toBe("1234.05");
    expect(centavosToDecimalString(-7)).toBe("-0.07");
  });

  it("margin percent", () => {
    expect(marginPercent(10000, 4000)).toBe(60);
    expect(marginPercent(0, 10)).toBeNull();
  });
});
