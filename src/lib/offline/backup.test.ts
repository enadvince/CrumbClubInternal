import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { KV, PosDatabase, type OutboxOp } from "./db";
import { buildBackup, dismissFailedOps, failedOpsCsv } from "./backup";

const op = (opId: string, status: OutboxOp["status"]): OutboxOp => ({
  opId, type: "sale", eventId: "e1", payload: { id: opId, total_centavos: 9500 }, effects: [{ eventProductId: "p1", delta: -1 }],
  createdAt: Date.UTC(2026, 9, 17, 2), status, attempts: 3, lastError: status === "failed" ? "event not found" : undefined,
  display: { orderNumber: `T5-261017-${opId}`, amount: 9500 },
});

describe("dismissFailedOps", () => {
  it("removes only rejected entries, keeps them for the emergency export", async () => {
    const db = new PosDatabase(`dismiss-${Math.random()}`);
    await db.outbox.bulkAdd([op("0001", "failed"), op("0002", "pending"), op("0003", "failed")]);
    const failed = await db.outbox.where("status").equals("failed").toArray();

    const csv = failedOpsCsv(failed);
    expect(csv.split("\n")[0]).toContain("server_error");
    expect(csv).toContain("T5-261017-0001");
    expect(csv).toContain("event not found");

    // One entry is retried before the owner confirms: it must stay in the queue.
    await db.outbox.where("opId").equals("0003").modify({ status: "pending" });
    expect(await dismissFailedOps(db, failed)).toBe(1);

    expect((await db.outbox.toArray()).map((o) => o.opId).sort()).toEqual(["0002", "0003"]);
    const kept = await db.getKv<OutboxOp[]>(KV.dismissedOps);
    expect(kept?.map((o) => o.opId)).toEqual(["0001"]);
    expect((await buildBackup(db)).dismissed.map((o) => o.opId)).toEqual(["0001"]);

    // Nothing left to dismiss is a no-op.
    expect(await dismissFailedOps(db, failed)).toBe(0);
    db.close();
  });
});
