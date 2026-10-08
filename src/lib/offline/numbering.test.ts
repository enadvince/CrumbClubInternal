import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KV, PosDatabase } from "./db";
import { recordSaleLocally } from "./actions";
import {
  applyDeviceState, DeviceNotRegisteredError, formatOrderNumber, manilaDayCode, mergeCounters, parseOrderNumber,
  shortOrderNumber,
} from "./numbering";
import { buildMenu, buildSale, priceCart } from "../pos/cart";
import { sampleSnapshot } from "../pos/fixtures";
import { uuidv7 } from "../uuid";

const MANILA_MIDNIGHT_OCT8 = Date.parse("2026-10-07T16:00:00Z"); // 00:00 on Oct 8 in Asia/Manila

let db: PosDatabase;
let name: string;

function draft(at: number, id = uuidv7(at)) {
  const menu = buildMenu(sampleSnapshot())!;
  const priced = priceCart([{ id: "l1", kind: "product", eventProductId: "ep-butter", quantity: 1 }], menu);
  return buildSale({ id, menu, priced, discount: null, payment: { method: "cash", cashReceived: priced.total }, staffId: "s1", createdAt: new Date(at) });
}
const sell = (at: number, id?: string) => recordSaleLocally(db, draft(at, id), { staffName: "A", summary: "x" }, at);

beforeEach(async () => {
  name = `num-${crypto.randomUUID()}`;
  db = new PosDatabase(name);
  await db.setKv(KV.device, { userId: "u1", deviceId: "device-1", deviceCode: "T1" });
});
afterEach(async () => {
  db.close();
  await PosDatabase.delete(name);
});

describe("order number format", () => {
  it("formats, parses and shortens", () => {
    expect(formatOrderNumber("T1", "261008", 42)).toBe("T1-261008-0042");
    expect(formatOrderNumber("T12", "261008", 12345)).toBe("T12-261008-12345");
    expect(parseOrderNumber("T1-261008-0042")).toEqual({ deviceCode: "T1", day: "261008", seq: 42 });
    expect(parseOrderNumber("LEGACY-261008-0001")).toBeNull();
    expect(shortOrderNumber("T1-261008-0042")).toBe("042");
    expect(shortOrderNumber("T1-261008-1042")).toBe("042");
  });

  it("uses the Asia/Manila calendar day", () => {
    expect(manilaDayCode(MANILA_MIDNIGHT_OCT8 - 1)).toBe("261007");
    expect(manilaDayCode(MANILA_MIDNIGHT_OCT8)).toBe("261008");
  });
});

describe("local order numbering", () => {
  it("counts up within a day and restarts at Manila midnight", async () => {
    const a = await sell(MANILA_MIDNIGHT_OCT8 - 60_000);
    const b = await sell(MANILA_MIDNIGHT_OCT8 - 1_000);
    const c = await sell(MANILA_MIDNIGHT_OCT8 + 1_000);
    const d = await sell(MANILA_MIDNIGHT_OCT8 + 60_000);
    expect([a, b, c, d].map((s) => s.orderNumber)).toEqual([
      "T1-261007-0001", "T1-261007-0002", "T1-261008-0001", "T1-261008-0002",
    ]);
  });

  it("gives every order in a burst of concurrent checkouts a distinct number", async () => {
    const at = MANILA_MIDNIGHT_OCT8 + 3_600_000;
    const sales = await Promise.all(Array.from({ length: 40 }, (_, i) => sell(at + i)));
    const numbers = sales.map((s) => s.orderNumber);
    expect(new Set(numbers).size).toBe(40);
    expect(numbers.map((n) => parseOrderNumber(n!)!.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    // Every order and its queue entry carry the same number.
    const ops = await db.outbox.toArray();
    expect(ops.map((o) => (o.payload as { order_number: string }).order_number).sort()).toEqual([...numbers].sort());
  });

  it("carries on from the last number when the clock jumps back to an earlier day", async () => {
    await sell(MANILA_MIDNIGHT_OCT8 - 10_000); // Oct 7 #1
    await sell(MANILA_MIDNIGHT_OCT8 + 10_000); // Oct 8 #1
    const back = await sell(MANILA_MIDNIGHT_OCT8 - 5_000); // clock set back to Oct 7
    expect(back.orderNumber).toBe("T1-261007-0002");
  });

  it("never reuses a number the server has already seen (e.g. after a reinstall)", async () => {
    await applyDeviceState(db, { id: "device-1", code: "T1", label: null, order_counters: { "261008": 41 } }, MANILA_MIDNIGHT_OCT8);
    expect((await sell(MANILA_MIDNIGHT_OCT8 + 5_000)).orderNumber).toBe("T1-261008-0042");
  });

  it("a failed save rolls the counter back with it, so no number is skipped or reused", async () => {
    const at = MANILA_MIDNIGHT_OCT8 + 5_000;
    const first = await sell(at, "same-id");
    await expect(sell(at + 1, "same-id")).rejects.toThrow(); // duplicate key aborts the transaction
    const next = await sell(at + 2);
    expect(first.orderNumber).toBe("T1-261008-0001");
    expect(next.orderNumber).toBe("T1-261008-0002");
    expect(await db.sales.count()).toBe(2);
  });

  it("refuses to sell before the tablet has a device code, and saves nothing", async () => {
    await db.setKv(KV.device, { userId: "u1" });
    await expect(sell(MANILA_MIDNIGHT_OCT8)).rejects.toBeInstanceOf(DeviceNotRegisteredError);
    expect(await db.sales.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe("mergeCounters", () => {
  it("keeps the highest sequence per day and drops old days across month ends", () => {
    expect(mergeCounters({ "261001": 5, "260920": 9 }, { "261001": 7, "260930": 3 }, "261001")).toEqual({ "261001": 7, "260930": 3 });
  });
});
