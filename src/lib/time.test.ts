import { describe, expect, it } from "vitest";
import { addDays, manilaDate, manilaDayStart, formatTime } from "./time";

describe("Manila time", () => {
  it("uses Manila calendar dates", () => {
    // 2026-10-07 17:30 UTC is 2026-10-08 01:30 in Manila
    expect(manilaDate("2026-10-07T17:30:00Z")).toBe("2026-10-08");
    expect(manilaDate("2026-10-07T15:59:00Z")).toBe("2026-10-07");
  });
  it("day start is midnight +08", () => {
    expect(manilaDayStart("2026-10-08")).toBe("2026-10-07T16:00:00.000Z");
  });
  it("adds days across months", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("formats times in Manila", () => {
    expect(formatTime("2026-10-10T03:40:00Z")).toMatch(/11:40/);
  });
});
