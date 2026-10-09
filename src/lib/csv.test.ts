import { describe, expect, it } from "vitest";
import { BOM, csvDate, csvMoney, toCsv } from "./csv";

describe("CSV rules", () => {
  it("starts with a UTF-8 BOM, has one header row and escapes commas, quotes and newlines", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], [null, "line\nbreak"]])).toBe(`${BOM}a,b\r\n"x,y","say ""hi"""\r\n,"line\nbreak"\r\n`);
    expect(toCsv(["only"], []).split("\r\n").filter(Boolean)).toHaveLength(1);
  });

  it("writes ISO 8601 dates in Asia/Manila time", () => {
    expect(csvDate("2026-10-07T16:30:00Z")).toBe("2026-10-08T00:30:00+08:00");
    expect(csvDate(Date.UTC(2026, 11, 31, 15, 59, 59))).toBe("2026-12-31T23:59:59+08:00");
    expect(csvDate(null)).toBe("");
  });

  it("writes amounts as plain numbers with 2 decimals", () => {
    expect(csvMoney(123450)).toBe("1234.50");
    expect(csvMoney(5)).toBe("0.05");
    expect(csvMoney(-9500)).toBe("-95.00");
    expect(csvMoney(null)).toBe("");
  });
});
