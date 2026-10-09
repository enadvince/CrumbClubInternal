import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KV, PosDatabase, type CachedSnapshot } from "./db";
import {
  recordSaleLocally, undoSale, adjustStockLocally, isDuplicateQrRef, logPinUseLocally, UndoError, voidOrderLocally, refundLocally, ActionError,
  openShiftLocally, drawerMovementLocally, closeShiftLocally, unsyncedForShift,
} from "./actions";
import { buildShiftReport } from "../pos/shift";
import { backupCsv, buildBackup } from "./backup";
import { localStock, summarizeOutbox } from "./stock";
import { IDLE_INTERVAL_MS, PENDING_INTERVAL_MS, SyncEngine, SyncError, type PinUsePayload, type SyncTransport } from "./sync";
import { addBundle, addProduct, buildMenu, buildSale, priceCart } from "../pos/cart";
import { sampleSnapshot } from "../pos/fixtures";
import type { CartLine, SalePayload, Snapshot } from "../pos/types";

/** In-memory stand-in for Supabase that behaves like the SQL RPCs (idempotent, ledger stock). */
class FakeServer implements SyncTransport {
  online = true;
  /** Record the next sale but "lose" the response */
  loseNextResponse = false;
  rejectSaleIds = new Set<string>();
  sales = new Map<string, SalePayload & { status: "completed" | "voided" }>();
  adjustments = new Map<string, { event_product_id: string; quantity_change: number }>();
  calls: string[] = [];
  private base = sampleSnapshot();

  private guard(what: string) {
    this.calls.push(what);
    if (!this.online) throw new SyncError("Failed to fetch", false);
  }
  async recordSale(sale: SalePayload) {
    this.guard(`sale:${sale.id}`);
    await this.onSend?.();
    if (this.rejectSaleIds.has(sale.id)) throw new SyncError("lines do not sum to subtotal", true);
    if (!this.sales.has(sale.id)) this.sales.set(sale.id, { ...sale, status: "completed" });
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new SyncError("network timeout", false);
    }
  }
  async voidSale(a: { transaction_id: string }) {
    this.guard(`void:${a.transaction_id}`);
    const s = this.sales.get(a.transaction_id);
    if (!s) throw new SyncError("transaction not found", true);
    s.status = "voided";
  }
  async adjustStock(p: Record<string, unknown>) {
    this.guard(`adjust:${p.id}`);
    if (!this.adjustments.has(p.id as string)) this.adjustments.set(p.id as string, p as never);
  }
  async setAvailability() { this.guard("availability"); }
  pinUses = new Map<string, PinUsePayload>();
  async logPinUse(u: PinUsePayload) {
    this.guard(`pin:${u.action}`);
    if (!this.pinUses.has(u.id)) this.pinUses.set(u.id, u);
  }
  async heartbeat() { /* not recorded */ }
  photos = new Map<string, number>();
  async uploadPaymentPhoto(a: { transactionId: string; bytes: ArrayBuffer }) {
    this.guard(`photo:${a.transactionId}`);
    if (!this.sales.has(a.transactionId)) throw new SyncError("order not found; it must sync before its photo", true);
    this.photos.set(a.transactionId, a.bytes.byteLength);
  }
  refunds = new Map<string, Record<string, unknown>>();
  audits = new Map<string, Record<string, unknown>>();
  async voidOrder(p: Record<string, unknown>) {
    this.guard(`void_order:${p.transaction_id}`);
    const s = this.sales.get(p.transaction_id as string);
    if (!s) throw new SyncError("order not found", true);
    s.status = "voided";
  }
  async refundOrder(p: Record<string, unknown>) {
    this.guard(`refund:${p.id}`);
    if (!this.sales.has(p.transaction_id as string)) throw new SyncError("order not found", true);
    if (!this.refunds.has(p.id as string)) this.refunds.set(p.id as string, p);
  }
  async logAudit(e: Record<string, unknown>) {
    this.guard(`audit:${e.action}`);
    if (!this.audits.has(e.id as string)) this.audits.set(e.id as string, e);
  }
  shifts = new Map<string, Record<string, unknown>>();
  movements = new Map<string, Record<string, unknown>>();
  async openShift(p: Record<string, unknown>) {
    this.guard("shift_open");
    if (!this.shifts.has(p.id as string)) this.shifts.set(p.id as string, { ...p, status: "open" });
  }
  async closeShift(p: Record<string, unknown>) {
    this.guard("shift_close");
    const s = this.shifts.get(p.id as string);
    if (!s) throw new SyncError("shift not found; it must sync first", true);
    Object.assign(s, p, { status: "closed" });
  }
  async drawerMovement(p: Record<string, unknown>) {
    this.guard("drawer");
    if (!this.shifts.has(p.shift_id as string)) throw new SyncError("shift not found; it must sync first", true);
    if (!this.movements.has(p.id as string)) this.movements.set(p.id as string, p);
  }
  async claimDeviceCode() { this.guard("claim"); return { device_id: "device-1", device_code: "T1", label: null }; }
  /** Health check fails while the API is down even if the device thinks it's online */
  apiDown = false;
  /** Called while a sale is being sent, to inspect the tablet's state mid-request */
  onSend: (() => Promise<void>) | null = null;
  async ping() {
    this.guard("ping");
    if (this.apiDown) throw new SyncError("503 Service Unavailable", false);
    return { server_time: new Date(clock + 90_000).toISOString() };
  }
  serverStock(ep: string) {
    const start = this.base.products!.find((p) => p.event_product_id === ep)!.stock;
    let sold = 0;
    for (const s of this.sales.values()) {
      if (s.status !== "completed") continue;
      for (const l of s.lines) for (const c of l.components) if (c.event_product_id === ep) sold += c.quantity;
    }
    let adj = 0;
    for (const a of this.adjustments.values()) if (a.event_product_id === ep) adj += a.quantity_change;
    let refunded = 0;
    for (const r of this.refunds.values()) {
      const sale = this.sales.get(r.transaction_id as string)!;
      if (sale.status !== "completed") continue;
      for (const rl of r.lines as { transaction_line_id: string; quantity: number }[]) {
        const line = sale.lines.find((l) => l.id === rl.transaction_line_id)!;
        for (const c of line.components) if (c.event_product_id === ep) refunded += (c.quantity * rl.quantity) / line.quantity;
      }
    }
    return start + adj - sold + refunded;
  }
  ownerVoid(id: string) { this.sales.get(id)!.status = "voided"; }
  async fetchSnapshot(): Promise<Snapshot> {
    this.guard("snapshot");
    const snap = structuredClone(this.base);
    snap.products = snap.products!.map((p) => ({ ...p, stock: this.serverStock(p.event_product_id) }));
    snap.voided_transaction_ids = [...this.sales.values()].filter((s) => s.status === "voided").map((s) => s.id);
    snap.recent_qr_refs = [...this.sales.values()].map((s) => s.qr_reference).filter((r): r is string => !!r);
    return snap;
  }
}

let dbName: string;
let db: PosDatabase;
let server: FakeServer;
let clock: number;
let online: boolean;
const now = () => clock;

function engine(database = db, locks: ConstructorParameters<typeof SyncEngine>[5] = null) {
  return new SyncEngine(database, server, now, () => online, () => 0.5, locks);
}

async function sell(cart: CartLine[], opts: { qr?: string; photo?: boolean } = {}) {
  const snap = (await db.getKv<CachedSnapshot>(KV.snapshot))!;
  const ops = await db.outbox.toArray();
  const menu = buildMenu(snap.snapshot, localStock(snap, ops))!;
  const priced = priceCart(cart, menu);
  const sale = buildSale({
    id: crypto.randomUUID(), menu, priced, discount: null,
    payment: opts.qr ? { method: "qr_ph", reference: opts.qr } : { method: "cash", cashReceived: priced.total },
    staffId: "staff-1", createdAt: new Date(clock),
  });
  const photo = opts.photo ? { bytes: new Uint8Array([1, 2, 3, 4]).buffer, mime: "image/jpeg" } : null;
  await recordSaleLocally(db, sale, { staffName: "Staff One", summary: "test", photo, businessId: "biz" }, clock);
  clock += 1000;
  return sale;
}

async function stockOf(ep: string) {
  const snap = await db.getKv<CachedSnapshot>(KV.snapshot);
  return localStock(snap, await db.outbox.toArray()).get(ep);
}

let n = 0;
const lineId = () => `l${++n}`;

beforeEach(async () => {
  dbName = `test-${crypto.randomUUID()}`;
  db = new PosDatabase(dbName);
  server = new FakeServer();
  clock = 1_000_000;
  online = true;
  // Start of day: download the menu while online.
  await engine().syncOnce();
});

afterEach(async () => {
  db.close();
  await PosDatabase.delete(dbName);
});

describe("offline sales", () => {
  it("records sales with no network and keeps local stock", async () => {
    online = false;
    server.online = false;
    await sell(addProduct([], "ep-ube", lineId));
    await sell(addBundle([], "eb-ubebox", lineId));
    const result = await engine().syncOnce();
    expect(result.ok).toBe(false);
    expect(server.sales.size).toBe(0);
    expect(summarizeOutbox(await db.outbox.toArray())).toMatchObject({ pending: 2, unsyncedSales: 2 });
    expect(await stockOf("ep-ube")).toBe(24 - 7);
  });

  it("syncs when the connection returns, without double-counting stock", async () => {
    online = false;
    server.online = false;
    await sell(addProduct([], "ep-ube", lineId));
    await sell(addBundle([], "eb-ubebox", lineId));
    online = true;
    server.online = true;
    const result = await engine().syncOnce();
    expect(result).toMatchObject({ ok: true, pushed: 2 });
    expect(server.sales.size).toBe(2);
    expect(server.serverStock("ep-ube")).toBe(17);
    // Server snapshot now includes both sales; local overlay must not subtract again.
    expect(await stockOf("ep-ube")).toBe(17);
    expect(summarizeOutbox(await db.outbox.toArray()).unsyncedSales).toBe(0);
    expect((await db.sales.toArray()).every((s) => s.syncedAt)).toBe(true);
  });
});

describe("retries and duplicate prevention", () => {
  it("a lost response is retried and does not create a duplicate", async () => {
    server.loseNextResponse = true;
    const sale = await sell(addProduct([], "ep-butter", lineId));
    const first = await engine().syncOnce();
    expect(first.ok).toBe(false);
    expect(server.sales.size).toBe(1); // server got it
    expect((await db.outbox.where("opId").equals(sale.id).first())!.status).toBe("pending");
    // While unacknowledged, the local overlay still subtracts it (snapshot not refreshed)
    expect(await stockOf("ep-butter")).toBe(23);

    clock += 5000;
    const second = await engine().syncOnce();
    expect(second.ok).toBe(true);
    expect(server.sales.size).toBe(1);
    expect(server.calls.filter((c) => c === `sale:${sale.id}`)).toHaveLength(2);
    expect(await stockOf("ep-butter")).toBe(23);
  });

  it("concurrent sync calls share one run (no double send)", async () => {
    const sale = await sell(addProduct([], "ep-butter", lineId));
    const e = engine();
    await Promise.all([e.syncOnce(), e.syncOnce(), e.syncOnce()]);
    expect(server.calls.filter((c) => c === `sale:${sale.id}`)).toHaveLength(1);
  });

  it("a transient failure stops the push so order is preserved", async () => {
    const a = await sell(addProduct([], "ep-butter", lineId));
    const b = await sell(addProduct([], "ep-ube", lineId));
    server.loseNextResponse = true; // a fails after recording
    await engine().syncOnce();
    expect(server.calls).not.toContain(`sale:${b.id}`);
    // a is backing off (about 2s), and holds b back so b can't overtake it.
    await engine().syncOnce();
    expect(server.calls.filter((c) => c.startsWith("sale:"))).toEqual([`sale:${a.id}`]);
    clock += 3000;
    await engine().syncOnce();
    const order = server.calls.filter((c) => c.startsWith("sale:"));
    expect(order).toEqual([`sale:${a.id}`, `sale:${a.id}`, `sale:${b.id}`]);
  });

  it("a permanently rejected sale is kept as failed and the rest still sync", async () => {
    const bad = await sell(addProduct([], "ep-butter", lineId));
    const good = await sell(addProduct([], "ep-ube", lineId));
    server.rejectSaleIds.add(bad.id);
    const result = await engine().syncOnce();
    expect(result).toMatchObject({ ok: true, pushed: 1, failedPermanently: 1 });
    expect(server.sales.has(good.id)).toBe(true);
    const failed = await db.outbox.where("opId").equals(bad.id).first();
    expect(failed!.status).toBe("failed");
    expect(failed!.lastError).toMatch(/subtotal/);
    // Still counted as unsynced (owner must deal with it) and still subtracts stock
    expect(summarizeOutbox(await db.outbox.toArray())).toMatchObject({ failed: 1, unsyncedSales: 1 });
    expect(await stockOf("ep-butter")).toBe(23);
  });
});

describe("recovery after app restart", () => {
  it("unsynced sales survive a restart and sync afterwards", async () => {
    online = false;
    server.online = false;
    const s1 = await sell(addProduct([], "ep-ube", lineId));
    const s2 = await sell(addBundle([], "eb-duo", lineId));
    db.close();

    // App restarts: new database handle, new engine.
    db = new PosDatabase(dbName);
    await db.open();
    expect(await db.outbox.where("status").equals("pending").count()).toBe(2);
    expect(await stockOf("ep-ube")).toBe(23);

    online = true;
    server.online = true;
    const result = await engine(db).syncOnce();
    expect(result.ok).toBe(true);
    expect([...server.sales.keys()].sort()).toEqual([s1.id, s2.id].sort());
  });
});

describe("undo and voids", () => {
  it("undo within 60s returns stock locally and on the server", async () => {
    const sale = await sell(addBundle([], "eb-ubebox", lineId));
    expect(await stockOf("ep-ube")).toBe(18);
    await undoSale(db, sale.id, "staff-1", clock + 10_000);
    expect(await stockOf("ep-ube")).toBe(24);
    await engine().syncOnce();
    expect(server.sales.get(sale.id)!.status).toBe("voided");
    expect(server.serverStock("ep-ube")).toBe(24);
    expect(await stockOf("ep-ube")).toBe(24);
  });

  it("undo after 60s is refused", async () => {
    const sale = await sell(addProduct([], "ep-ube", lineId));
    await expect(undoSale(db, sale.id, "staff-1", clock + 61_000)).rejects.toBeInstanceOf(UndoError);
  });

  it("undo while offline before the sale synced sends sale then void", async () => {
    online = false;
    server.online = false;
    const sale = await sell(addProduct([], "ep-ube", lineId));
    await undoSale(db, sale.id, "staff-1", clock);
    online = true;
    server.online = true;
    await engine().syncOnce();
    expect(server.calls.filter((c) => c.endsWith(sale.id))).toEqual([`sale:${sale.id}`, `void:${sale.id}`]);
    expect(server.serverStock("ep-ube")).toBe(24);
  });

  it("owner voids from another device are applied on the next pull", async () => {
    const sale = await sell(addProduct([], "ep-ube", lineId));
    await engine().syncOnce();
    server.ownerVoid(sale.id);
    await engine().syncOnce();
    expect((await db.sales.get(sale.id))!.status).toBe("voided");
    expect(await stockOf("ep-ube")).toBe(24);
  });
});

describe("stock overlay timing", () => {
  it("a sale acknowledged after the snapshot started is still subtracted locally", async () => {
    await sell(addProduct([], "ep-almond", lineId));
    // Snapshot request sent *before* the sale is acknowledged (older server numbers)...
    const stale = await server.fetchSnapshot();
    await db.setKv<CachedSnapshot>(KV.snapshot, { snapshot: stale, pulledAt: clock, pullSeq: 100 });
    // ...then the sale syncs (acknowledged later: higher counter value, same wall-clock ms).
    const op = (await db.outbox.toArray())[0];
    await server.recordSale(op.payload as SalePayload);
    await db.outbox.update(op.seq!, { status: "synced", syncedAt: clock, ackSeq: 101 });
    expect(await stockOf("ep-almond")).toBe(11);
  });

  it("restocks made on the tablet count immediately and once", async () => {
    await adjustStockLocally(db, { eventId: "event-1", eventProductId: "ep-almond", quantityChange: 12, reason: "restock", staffId: "owner" }, clock);
    expect(await stockOf("ep-almond")).toBe(24);
    clock += 1000;
    await engine().syncOnce();
    expect(server.serverStock("ep-almond")).toBe(24);
    expect(await stockOf("ep-almond")).toBe(24);
  });
});

describe("QR Ph references", () => {
  it("flags a reference used locally or on the server", async () => {
    await sell(addProduct([], "ep-ube", lineId), { qr: "5012345678901" });
    expect(await isDuplicateQrRef(db, "5012345678901", [])).toBe(true);
    expect(await isDuplicateQrRef(db, "999", ["999"])).toBe(true);
    expect(await isDuplicateQrRef(db, "123", [])).toBe(false);
  });
});

describe("PIN log", () => {
  it("PIN uses recorded offline sync in order with sales and don't count as sales", async () => {
    online = false;
    server.online = false;
    await logPinUseLocally(db, "staff-1", "sign_in", "", clock);
    await sell([...addProduct([], "ep-ube", lineId)]);
    await logPinUseLocally(db, "staff-owner", "void_approval", "", clock);
    const summary = summarizeOutbox(await db.outbox.toArray());
    expect(summary.unsyncedSales).toBe(1);
    expect(summary.pending).toBe(3);

    online = true;
    server.online = true;
    await engine().syncOnce();
    expect([...server.pinUses.values()].map((u) => u.action)).toEqual(["sign_in", "void_approval"]);
    const pushed = server.calls.filter((c) => c.startsWith("pin:") || c.startsWith("sale:"));
    expect(pushed[0]).toBe("pin:sign_in");
    expect(pushed[1]).toMatch(/^sale:/);
    expect(summarizeOutbox(await db.outbox.toArray()).pending).toBe(0);
  });
});

describe("sync states, backoff and health checks", () => {
  it("moves an order through pending, syncing and synced", async () => {
    const sale = await sell(addProduct([], "ep-butter", lineId));
    const statusOf = async () => (await db.outbox.where("opId").equals(sale.id).first())!.status;
    expect(await statusOf()).toBe("pending");
    let during: string | null = null;
    server.onSend = async () => { during = await statusOf(); };
    await engine().syncOnce();
    expect(during).toBe("syncing");
    expect(await statusOf()).toBe("synced");
  });

  it("a retryable failure records attempts, the error and the next retry time", async () => {
    const sale = await sell(addProduct([], "ep-butter", lineId));
    server.loseNextResponse = true;
    await engine().syncOnce();
    const op = (await db.outbox.where("opId").equals(sale.id).first())!;
    expect(op).toMatchObject({ status: "pending", attempts: 1, lastError: "network timeout" });
    expect(op.nextRetryAt).toBe(clock + 2000); // 2s with neutral jitter
  });

  it("an entry interrupted mid-send (tab killed) is sent again and never duplicated", async () => {
    const sale = await sell(addProduct([], "ep-butter", lineId));
    // Simulate a crash after the server stored the sale but before the tablet marked it synced.
    await server.recordSale(sale);
    await db.outbox.where("opId").equals(sale.id).modify({ status: "syncing" });
    const result = await engine().syncOnce();
    expect(result.ok).toBe(true);
    expect((await db.outbox.where("opId").equals(sale.id).first())!.status).toBe("synced");
    expect(server.sales.size).toBe(1);
  });

  it("re-sending every order again (forced resync) still leaves exactly one copy of each", async () => {
    const sales = [await sell(addProduct([], "ep-butter", lineId)), await sell(addProduct([], "ep-ube", lineId)), await sell(addProduct([], "ep-choc", lineId))];
    await engine().syncOnce();
    await db.outbox.where("type").equals("sale").modify({ status: "pending" });
    await engine().syncOnce();
    expect(server.sales.size).toBe(3);
    expect(sales.every((s) => server.sales.has(s.id))).toBe(true);
  });

  it("doesn't trust navigator.onLine: a failed health check means offline and nothing is sent", async () => {
    const sale = await sell(addProduct([], "ep-butter", lineId));
    server.apiDown = true;
    const result = await engine().syncOnce();
    expect(result).toMatchObject({ ok: false, error: "offline" });
    expect(server.calls).not.toContain(`sale:${sale.id}`);
    // No attempt was made, so no backoff either.
    expect((await db.outbox.where("opId").equals(sale.id).first())!.attempts).toBe(0);
  });

  it("measures the tablet's clock offset from the health check", async () => {
    const e = engine();
    await e.syncOnce();
    expect(e.state.clockOffsetMs).toBe(90_000);
    expect(await db.getKv(KV.clockOffsetMs)).toBe(90_000);
  });

  it("Retry now clears a failure and the backoff", async () => {
    const bad = await sell(addProduct([], "ep-butter", lineId));
    server.rejectSaleIds.add(bad.id);
    const e = engine();
    await e.syncOnce();
    const op = (await db.outbox.where("opId").equals(bad.id).first())!;
    expect(op.status).toBe("failed");
    server.rejectSaleIds.clear();
    await e.retryNow(op.seq);
    expect((await db.outbox.where("opId").equals(bad.id).first())!.status).toBe("synced");
  });

  it("only one tab syncs at a time (Web Locks)", async () => {
    await sell(addProduct([], "ep-butter", lineId));
    let held = false;
    const locks = {
      async request<T>(_: string, __: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<T>): Promise<T> {
        if (held) return cb(null);
        held = true;
        try { return await cb({}); } finally { held = false; }
      },
    };
    const db2 = new PosDatabase(dbName); // second tab, same IndexedDB
    const [r1, r2] = await Promise.all([engine(db, locks).syncOnce(), engine(db2, locks).syncOnce()]);
    db2.close();
    expect([r1.skipped, r2.skipped].filter(Boolean)).toHaveLength(1);
    expect(server.calls.filter((c) => c.startsWith("sale:"))).toHaveLength(1);
  });

  it("checks every 30s while orders wait, sooner when a backoff ends, every 60s when idle", async () => {
    const e = engine();
    expect(await e.nextDelay()).toBe(IDLE_INTERVAL_MS);
    await sell(addProduct([], "ep-butter", lineId));
    expect(await e.nextDelay()).toBe(1_000); // due now: go again soon
    server.loseNextResponse = true;
    await e.syncOnce();
    expect(await e.nextDelay()).toBe(2_000);
    await db.outbox.where("status").equals("pending").modify({ nextRetryAt: clock + 120_000 });
    expect(await e.nextDelay()).toBe(PENDING_INTERVAL_MS);
  });
});

describe("payments while offline", () => {
  it("cash is final; QR is awaiting verification and never marked verified on the tablet", async () => {
    online = false;
    const cash = await sell(addProduct([], "ep-butter", lineId));
    const qr = await sell(addProduct([], "ep-ube", lineId), { qr: "5012345678901" });
    expect((await db.sales.get(cash.id))!.paymentStatus).toBe("paid");
    expect((await db.sales.get(qr.id))!.paymentStatus).toBe("awaiting_verification");
    online = true;
    await engine().syncOnce();
    expect((await db.sales.get(qr.id))!.paymentStatus).toBe("awaiting_verification");
  });

  it("a QR payment photo is kept on the tablet and uploaded after its order", async () => {
    online = false;
    const qr = await sell(addProduct([], "ep-ube", lineId), { qr: "5012345678902", photo: true });
    const queued = await db.outbox.orderBy("seq").toArray();
    expect(queued.map((o) => o.type)).toEqual(["sale", "qr_photo"]);
    expect((await db.photos.get(qr.id))!.bytes.byteLength).toBe(4);
    online = true;
    await engine().syncOnce();
    const order = server.calls.filter((c) => c.startsWith("sale:") || c.startsWith("photo:"));
    expect(order).toEqual([`sale:${qr.id}`, `photo:${qr.id}`]);
    expect(server.photos.get(qr.id)).toBe(4);
    expect((await db.photos.get(qr.id))!.uploadedPath).toBe(`biz/${qr.id}.jpg`);
  });
});

describe("owner-approved voids and refunds offline", () => {
  it("void and partial refund offline, then sync: audit entries land and stock is restored once", async () => {
    online = false;
    const a = await sell(addProduct(addProduct([], "ep-butter", lineId), "ep-butter", lineId)); // 2 butter
    const b = await sell(addBundle([], "eb-ubebox", lineId)); // 6 ube
    expect(await stockOf("ep-butter")).toBe(22);
    expect(await stockOf("ep-ube")).toBe(18);

    await voidOrderLocally(db, { saleId: b.id, reasonCode: "wrong_item", cashierId: "staff-1", approverId: "staff-owner" }, clock);
    const lineA = a.lines[0].id;
    const refund = await refundLocally(db, {
      saleId: a.id, kind: "refund", lines: [{ lineId: lineA, quantity: 1 }], method: "cash", reasonCode: "changed_mind",
      cashierId: "staff-1", approverId: "staff-owner",
    }, clock + 10);
    expect(refund.amount).toBe(9500);
    expect(await stockOf("ep-ube")).toBe(24);
    expect(await stockOf("ep-butter")).toBe(23);
    expect((await db.sales.get(b.id))!).toMatchObject({ status: "voided", voidReason: "Wrong item" });
    // The voided order keeps its number.
    expect((await db.sales.get(b.id))!.orderNumber).toMatch(/^T1-\d{6}-0002$/);

    online = true;
    await engine().syncOnce();
    expect(server.sales.get(b.id)!.status).toBe("voided");
    expect(server.refunds.size).toBe(1);
    expect([...server.audits.values()].map((e) => e.action).sort()).toEqual(["refund", "void"]);
    const voidAudit = [...server.audits.values()].find((e) => e.action === "void")!;
    expect(voidAudit).toMatchObject({ manager_staff_id: "staff-owner", cashier_staff_id: "staff-1", transaction_id: b.id });
    expect(voidAudit.device_time).toBeTruthy();
    expect(server.serverStock("ep-ube")).toBe(24);
    expect(server.serverStock("ep-butter")).toBe(23);
    // After the pull, local stock equals the server's: nothing counted twice.
    expect(await stockOf("ep-ube")).toBe(24);
    expect(await stockOf("ep-butter")).toBe(23);
  });

  it("refuses to refund more than was sold, to void a refunded order, or to refund a voided one", async () => {
    const a = await sell(addProduct([], "ep-butter", lineId));
    const line = a.lines[0].id;
    await refundLocally(db, { saleId: a.id, kind: "refund", lines: [{ lineId: line, quantity: 1 }], method: "cash", reasonCode: "x", cashierId: "s", approverId: "o" });
    await expect(refundLocally(db, { saleId: a.id, kind: "refund", lines: [{ lineId: line, quantity: 1 }], method: "cash", reasonCode: "x", cashierId: "s", approverId: "o" })).rejects.toBeInstanceOf(ActionError);
    await expect(voidOrderLocally(db, { saleId: a.id, reasonCode: "duplicate", cashierId: "s", approverId: "o" })).rejects.toThrow(/refund/);
    const b = await sell(addProduct([], "ep-ube", lineId));
    await voidOrderLocally(db, { saleId: b.id, reasonCode: "other", note: "test", cashierId: "s", approverId: "o" });
    await expect(refundLocally(db, { saleId: b.id, kind: "refund", lines: [{ lineId: b.lines[0].id, quantity: 1 }], method: "cash", reasonCode: "x", cashierId: "s", approverId: "o" })).rejects.toThrow(/voided/);
  });

  it("an 'Other' void needs a note", async () => {
    const a = await sell(addProduct([], "ep-butter", lineId));
    await expect(voidOrderLocally(db, { saleId: a.id, reasonCode: "other", cashierId: "s", approverId: "o" })).rejects.toThrow(/note/);
  });
});

describe("a full shift offline", () => {
  it("open, sell, cash out, refund, close: provisional until synced, then final and on the server", async () => {
    online = false;
    const shift = await openShiftLocally(db, { eventId: "event-1", staffId: "staff-1", staffName: "Staff One", openingFloat: 100000, openingDenoms: { b1000: 1 } }, clock);
    await expect(openShiftLocally(db, { eventId: "event-1", staffId: "staff-1", staffName: "Staff One", openingFloat: 0, openingDenoms: null }, clock)).rejects.toThrow(/already open/);
    const a = await sell(addProduct(addProduct([], "ep-butter", lineId), "ep-butter", lineId)); // cash 19000
    await sell(addProduct([], "ep-ube", lineId), { qr: "5012" }); // QR 12000
    const c = await sell(addProduct([], "ep-choc", lineId)); // cash 11000
    expect((await db.sales.get(a.id))!.shiftId).toBe(shift.id);
    await expect(drawerMovementLocally(db, { shiftId: shift.id, kind: "cash_out", amount: 5000, reason: "ice", staffId: "staff-1", staffName: "Staff One" })).rejects.toThrow(/owner/);
    await drawerMovementLocally(db, { shiftId: shift.id, kind: "cash_out", amount: 5000, reason: "ice", staffId: "staff-1", staffName: "Staff One", approverId: "staff-owner" }, clock);
    await refundLocally(db, { saleId: a.id, kind: "refund", lines: [{ lineId: a.lines[0].id, quantity: 1 }], method: "cash", reasonCode: "changed_mind", cashierId: "staff-1", approverId: "staff-owner", shiftId: shift.id }, clock);
    await voidOrderLocally(db, { saleId: c.id, reasonCode: "wrong_item", cashierId: "staff-1", approverId: "staff-owner", shiftId: shift.id }, clock);

    const data = async () => ({
      sales: await db.sales.toArray(), refunds: await db.refunds.toArray(), drawer: await db.drawer.toArray(),
      unsynced: await unsyncedForShift(db, shift.id),
    });
    let report = buildShiftReport((await db.shifts.get(shift.id))!, await data());
    // 100000 float + 19000 cash − 9500 refund − 5000 out = 104500
    expect(report.expectedCash).toBe(104500);
    expect(report).toMatchObject({ orders: 2, voids: { count: 1, total: 11000 }, refunds: { count: 1, total: 9500, cash: 9500 }, netSales: 21500 });
    expect(report.qrAwaiting).toEqual({ count: 1, total: 12000 });

    // Blind count ₱100 short: needs an owner and a note.
    await expect(closeShiftLocally(db, { shiftId: shift.id, staffId: "staff-1", staffName: "Staff One", countedCash: 94500, countedDenoms: null, expectedCash: report.expectedCash, threshold: 5000 })).rejects.toThrow(/owner PIN/);
    await closeShiftLocally(db, {
      shiftId: shift.id, staffId: "staff-1", staffName: "Staff One", countedCash: 94500, countedDenoms: null, expectedCash: report.expectedCash,
      threshold: 5000, varianceNote: "short change", approverId: "staff-owner", approverName: "Owner",
    }, clock);
    report = buildShiftReport((await db.shifts.get(shift.id))!, await data());
    expect(report.variance).toBe(-10000);
    expect(report.unsynced.orders).toBe(3); // provisional
    expect(report.unsynced.other).toBeGreaterThan(0);

    online = true;
    await engine().syncOnce();
    report = buildShiftReport((await db.shifts.get(shift.id))!, await data());
    expect(report.unsynced).toEqual({ orders: 0, other: 0 }); // final
    expect(server.shifts.get(shift.id)).toMatchObject({ status: "closed", counted_cash_centavos: 94500, expected_cash_centavos: 104500 });
    expect(server.movements.size).toBe(1);
    // Every order went up with its shift, in order: shift opened before its first sale.
    const firstShift = server.calls.indexOf("shift_open");
    const firstSale = server.calls.findIndex((c) => c.startsWith("sale:"));
    expect(firstShift).toBeLessThan(firstSale);
    expect([...server.sales.values()].every((s) => s.shift_id === shift.id)).toBe(true);
  });
});

describe("emergency export", () => {
  it("includes every unsynced order, refund, shift and drawer movement", async () => {
    online = false;
    const shift = await openShiftLocally(db, { eventId: "event-1", staffId: "staff-1", staffName: "Staff One", openingFloat: 50000, openingDenoms: null }, clock);
    const a = await sell(addProduct([], "ep-butter", lineId));
    await drawerMovementLocally(db, { shiftId: shift.id, kind: "cash_in", amount: 1000, reason: "coins", staffId: "staff-1", staffName: "Staff One" }, clock);
    await refundLocally(db, { saleId: a.id, kind: "refund", lines: [{ lineId: a.lines[0].id, quantity: 1 }], method: "cash", reasonCode: "changed_mind", cashierId: "staff-1", approverId: "staff-owner", shiftId: shift.id }, clock);
    const exp = await buildBackup(db);
    expect(exp.device?.deviceCode).toBe("T1");
    expect(exp.sales.map((s) => s.id)).toContain(a.id);
    expect(exp.unsynced.map((o) => o.type)).toEqual(expect.arrayContaining(["shift_open", "sale", "drawer", "refund", "audit"]));
    expect(exp.shifts).toHaveLength(1);
    expect(exp.drawer).toHaveLength(1);
    expect(exp.refunds).toHaveLength(1);
    const csv = await backupCsv(db);
    expect(csv.startsWith("\uFEFFclient_order_id,order_number")).toBe(true);
    expect(csv).toMatch(/T1-\d{6}-0001/);
    expect(csv).toContain(",NO,cash,paid,");
  });
});
