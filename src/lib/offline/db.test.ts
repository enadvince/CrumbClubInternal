import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { PosDatabase } from "./db";

describe("IndexedDB upgrade from v1", () => {
  it("keeps unsynced sales and queue entries, and backfills payment status", async () => {
    const name = `upgrade-${Math.random()}`;
    // Simulate a tablet still on the v1 schema with unsynced data.
    const v1 = new Dexie(name);
    v1.version(1).stores({ kv: "key", sales: "id, eventId, staffId, createdAt, status", outbox: "++seq, &opId, status, type, createdAt" });
    await v1.table("sales").bulkAdd([
      { id: "s1", eventId: "e", staffId: "a", createdAt: "2026-10-08T01:00:00Z", status: "completed", paymentMethod: "cash", total: 9500 },
      { id: "s2", eventId: "e", staffId: "a", createdAt: "2026-10-08T01:05:00Z", status: "completed", paymentMethod: "qr_ph", total: 12000 },
    ]);
    await v1.table("outbox").add({ opId: "s1", type: "sale", status: "pending", createdAt: 1, attempts: 0, effects: [], eventId: "e", payload: {} });
    await v1.table("kv").put({ key: "device", value: { userId: "u1" } });
    v1.close();

    const db = new PosDatabase(name);
    await db.open();
    expect(db.verno).toBe(2);
    expect(await db.outbox.where("status").equals("pending").count()).toBe(1);
    expect((await db.sales.get("s1"))?.paymentStatus).toBe("paid");
    expect((await db.sales.get("s2"))?.paymentStatus).toBe("awaiting_verification");
    expect(await db.getKv("device")).toEqual({ userId: "u1" });
    // New stores exist and work.
    await db.shifts.add({ id: "sh", eventId: "e", deviceId: "d", status: "open", openedAt: "x", openedByStaffId: "a", openedByName: "A", openingFloat: 0, openingDenoms: null });
    expect(await db.shifts.where("status").equals("open").count()).toBe(1);
    db.close();
  });
});
