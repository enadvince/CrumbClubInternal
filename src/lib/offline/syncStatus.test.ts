import { describe, expect, it } from "vitest";
import { connectionToast, pillState } from "./syncStatus";
import type { UnsyncedSummary } from "./stock";

const sum = (p: Partial<UnsyncedSummary> = {}): UnsyncedSummary => ({
  pending: 0, failed: 0, unsyncedSales: 0, pendingSales: 0, failedSales: 0, oldestUnsyncedAt: null, ...p,
});
const online = { online: true, syncing: false };

describe("sync pill", () => {
  it("green when everything is synced", () => {
    expect(pillState(online, sum())).toEqual({ tone: "ok", text: "All synced", spinner: false });
  });
  it("amber with a live, correctly pluralised count", () => {
    expect(pillState(online, sum({ pending: 3, pendingSales: 3 })).text).toBe("3 orders pending sync");
    expect(pillState(online, sum({ pending: 1, pendingSales: 1 })).text).toBe("1 order pending sync");
    expect(pillState(online, sum({ pending: 2 })).text).toBe("2 changes pending sync");
  });
  it("blue with a spinner while syncing", () => {
    expect(pillState({ online: true, syncing: true }, sum({ pending: 3, pendingSales: 3 }))).toEqual({ tone: "syncing", text: "Syncing 3 orders...", spinner: true });
  });
  it("grey when offline", () => {
    expect(pillState({ online: false, syncing: false }, sum({ pending: 3, pendingSales: 3 })).text).toBe("Offline: orders saved on this device");
  });
  it("red when anything was rejected, even offline", () => {
    expect(pillState({ online: false, syncing: false }, sum({ failed: 2, failedSales: 2 }))).toEqual({ tone: "attention", text: "2 orders need attention", spinner: false });
    expect(pillState(online, sum({ failed: 1, failedSales: 1 })).text).toBe("1 order needs attention");
  });
});

describe("connection toasts", () => {
  it("announces drops and returns with the waiting count", () => {
    expect(connectionToast(true, false, sum())).toMatch(/Connection lost/);
    expect(connectionToast(false, true, sum({ pendingSales: 3 }))).toBe("Back online, syncing 3 orders");
    expect(connectionToast(false, true, sum())).toBe("Back online");
    expect(connectionToast(true, true, sum())).toBeNull();
  });
});
