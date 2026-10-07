import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KV, PosDatabase, type CachedSnapshot } from "./db";
import { recordSaleLocally, undoSale, adjustStockLocally, isDuplicateQrRef, UndoError } from "./actions";
import { localStock, summarizeOutbox } from "./stock";
import { SyncEngine, SyncError, type SyncTransport } from "./sync";
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
  async heartbeat() { /* not recorded */ }
  serverStock(ep: string) {
    const start = this.base.products!.find((p) => p.event_product_id === ep)!.stock;
    let sold = 0;
    for (const s of this.sales.values()) {
      if (s.status !== "completed") continue;
      for (const l of s.lines) for (const c of l.components) if (c.event_product_id === ep) sold += c.quantity;
    }
    let adj = 0;
    for (const a of this.adjustments.values()) if (a.event_product_id === ep) adj += a.quantity_change;
    return start + adj - sold;
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

function engine(database = db) {
  return new SyncEngine(database, server, now, () => online);
}

async function sell(cart: CartLine[], opts: { qr?: string } = {}) {
  const snap = (await db.getKv<CachedSnapshot>(KV.snapshot))!;
  const ops = await db.outbox.toArray();
  const menu = buildMenu(snap.snapshot, localStock(snap, ops))!;
  const priced = priceCart(cart, menu);
  const sale = buildSale({
    id: crypto.randomUUID(), menu, priced, discount: null,
    payment: opts.qr ? { method: "qr_ph", reference: opts.qr } : { method: "cash", cashReceived: priced.total },
    staffId: "staff-1", createdAt: new Date(clock),
  });
  await recordSaleLocally(db, sale, { staffName: "Staff One", summary: "test" }, clock);
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
