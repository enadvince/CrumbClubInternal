/*
 * Integration tests: the real SyncEngine and the real SQL functions (local Postgres 16 with
 * every migration applied). Run by `npm run test:db`, which starts the database and sets PG*.
 */
import "fake-indexeddb/auto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KV, PosDatabase, type CachedSnapshot } from "./db";
import { SyncEngine } from "./sync";
import {
  closeShiftLocally, drawerMovementLocally, openShiftLocally, recordSaleLocally, refundLocally, unsyncedForShift, voidOrderLocally,
} from "./actions";
import { localStock } from "./stock";
import { addProduct, buildMenu, buildSale, priceCart } from "../pos/cart";
import { buildShiftReport, fromServerShiftReport, type ServerShiftReport } from "../pos/shift";
import { findStaffByPin } from "../pin";
import type { CartLine } from "../pos/types";
import { uuidv7 } from "../uuid";
import { asUser, createFixture, pgConfig, pgTransport } from "../../test/pgTransport";

let pg: Client;
let db: PosDatabase;
let fx: Awaited<ReturnType<typeof createFixture>>;
let net: ReturnType<typeof pgTransport>;
let engine: SyncEngine;
let staffId: string;
let n = 0;

beforeAll(async () => {
  pg = new Client(pgConfig());
  await pg.connect();
});
afterAll(async () => { await pg.end(); });

beforeEach(async () => {
  fx = await createFixture(pg);
  db = new PosDatabase(`int-${crypto.randomUUID()}`);
  net = pgTransport(pg, fx.device);
  engine = new SyncEngine(db, net.transport, Date.now, () => net.state.online, Math.random, null);
  // Start of day, online: register the tablet and download the menu.
  const claimed = await net.transport.claimDeviceCode();
  await db.setKv(KV.device, { userId: fx.device, deviceId: claimed.device_id, deviceCode: claimed.device_code });
  expect((await engine.syncOnce()).ok).toBe(true);
  const snap = (await db.getKv<CachedSnapshot>(KV.snapshot))!.snapshot;
  staffId = snap.staff.find((s) => s.name === "Staff One")!.id;
});

async function menu() {
  const cached = (await db.getKv<CachedSnapshot>(KV.snapshot))!;
  return { cached, menu: buildMenu(cached.snapshot, localStock(cached, await db.outbox.toArray()))! };
}
async function epId(name: string) {
  const { menu: m } = await menu();
  return [...m.products.values()].find((p) => p.name === name)!.event_product_id;
}
async function sell(name: string, qty = 1, payment: "cash" | "qr" = "cash") {
  const { menu: m } = await menu();
  const ep = await epId(name);
  let cart: CartLine[] = [];
  for (let i = 0; i < qty; i++) { n++; cart = addProduct(cart, ep, () => crypto.randomUUID()); }
  const priced = priceCart(cart, m);
  const at = Date.now();
  const sale = buildSale({
    id: uuidv7(at), menu: m, priced, discount: null, staffId, createdAt: new Date(at),
    payment: payment === "cash" ? { method: "cash", cashReceived: priced.total } : { method: "qr_ph", reference: `ref-${n}` },
  });
  return recordSaleLocally(db, sale, { staffName: "Staff One", summary: name }, at);
}
/** Entries the server rejected, with its message: shown in the assertion when something fails. */
const failures = async () => (await db.outbox.where("status").equals("failed").toArray()).map((o) => `${o.type}: ${o.lastError}`);
const serverCount = (sql: string, params: unknown[] = []) => pg.query(sql, params).then((r) => Number(r.rows[0].count));
const serverStock = (ep: string) => pg.query("select current_stock from public.event_products where id = $1", [ep]).then((r) => Number(r.rows[0].current_stock));

describe("integration: offline orders against the real database", () => {
  it("3 orders offline, back online: exactly 3 rows; a forced re-sync still leaves exactly 3", async () => {
    net.state.online = false;
    const sales = [await sell("Butter Croissant"), await sell("Ube Croissant", 2), await sell("Ensaymada", 1, "qr")];
    expect(await serverCount("select count(*) from public.transactions where business_id = $1", [fx.business])).toBe(0);

    net.state.online = true;
    const first = await engine.syncOnce();
    expect(await failures()).toEqual([]);
    expect(first.pushed).toBeGreaterThanOrEqual(3);
    expect(await serverCount("select count(*) from public.transactions where business_id = $1", [fx.business])).toBe(3);

    // Force every order to be sent again (as if acknowledgements were lost).
    await db.outbox.where("type").equals("sale").modify({ status: "pending" });
    await engine.syncOnce();
    expect(await serverCount("select count(*) from public.transactions where business_id = $1", [fx.business])).toBe(3);
    expect(await serverCount("select count(*) from public.transaction_lines l join public.transactions t on t.id = l.transaction_id where t.business_id = $1", [fx.business])).toBe(3);

    // Numbers, device and payment status made it as the tablet assigned them.
    const rows = (await pg.query("select id, order_number, device_id, payment_status from public.transactions where business_id = $1 order by order_number", [fx.business])).rows;
    expect(rows.map((r) => r.order_number)).toEqual(sales.map((s) => s.orderNumber).sort());
    expect(rows.every((r) => r.order_number.startsWith("T1-"))).toBe(true);
    expect(rows.find((r) => r.id === sales[2].id).payment_status).toBe("awaiting_verification");
  });

  it("void and refund offline with an owner PIN, then sync: audit entries and restored stock", async () => {
    const butter = await epId("Butter Croissant");
    const ube = await epId("Ube Croissant");
    const before = { butter: await serverStock(butter), ube: await serverStock(ube) };
    net.state.online = false;
    const a = await sell("Butter Croissant", 2);
    const b = await sell("Ube Croissant", 1);
    // The owner PIN is checked on the tablet against the cached hash.
    const { cached } = await menu();
    const owner = await findStaffByPin("9001", cached.snapshot.staff.filter((s) => s.role === "owner"));
    expect(owner?.name).toBe("Owner I");
    await voidOrderLocally(db, { saleId: b.id, reasonCode: "wrong_item", cashierId: staffId, approverId: owner!.id });
    await refundLocally(db, {
      saleId: a.id, kind: "refund", lines: [{ lineId: a.payload.lines[0].id, quantity: 1 }], method: "cash",
      reasonCode: "changed_mind", cashierId: staffId, approverId: owner!.id,
    });

    net.state.online = true;
    await engine.syncOnce();
    expect(await failures()).toEqual([]);
    const audit = (await pg.query("select action, manager_staff_id, cashier_staff_id, device_id is not null as has_device, order_number from public.audit_log where business_id = $1 order by action", [fx.business])).rows;
    expect(audit.map((r) => r.action)).toEqual(["refund", "void"]);
    expect(audit.every((r) => r.manager_staff_id === owner!.id && r.cashier_staff_id === staffId && r.has_device)).toBe(true);
    expect((await pg.query("select status, void_reason_code from public.transactions where id = $1", [b.id])).rows[0]).toEqual({ status: "voided", void_reason_code: "wrong_item" });
    expect(await serverStock(butter)).toBe(before.butter - 1); // sold 2, refunded 1
    expect(await serverStock(ube)).toBe(before.ube); // voided
    // The tablet agrees with the server after the pull.
    const { cached: after, } = await menu();
    expect(localStock(after, await db.outbox.toArray()).get(butter)).toBe(before.butter - 1);
  });

  it("a full shift offline (open, sales, cash out, refund, close) matches the server's shift report after sync", async () => {
    net.state.online = false;
    const { cached } = await menu();
    const owner = cached.snapshot.staff.find((s) => s.role === "owner")!;
    const shift = await openShiftLocally(db, { eventId: fx.event, staffId, staffName: "Staff One", openingFloat: 100000, openingDenoms: { b1000: 1 } });
    const a = await sell("Butter Croissant", 2);
    await sell("Ube Croissant", 1, "qr");
    const c = await sell("Pain au Chocolat", 1);
    await drawerMovementLocally(db, { shiftId: shift.id, kind: "cash_out", amount: 5000, reason: "ice supplier", staffId, staffName: "Staff One", approverId: owner.id });
    await drawerMovementLocally(db, { shiftId: shift.id, kind: "cash_in", amount: 2000, reason: "coins", staffId, staffName: "Staff One" });
    await refundLocally(db, { saleId: a.id, kind: "refund", lines: [{ lineId: a.payload.lines[0].id, quantity: 1 }], method: "cash", reasonCode: "changed_mind", cashierId: staffId, approverId: owner.id, shiftId: shift.id });
    await voidOrderLocally(db, { saleId: c.id, reasonCode: "duplicate", cashierId: staffId, approverId: owner.id, shiftId: shift.id });
    const local = async () => buildShiftReport((await db.shifts.get(shift.id))!, {
      sales: await db.sales.toArray(), refunds: await db.refunds.toArray(), drawer: await db.drawer.toArray(), unsynced: await unsyncedForShift(db, shift.id),
    });
    const pre = await local();
    await closeShiftLocally(db, {
      shiftId: shift.id, staffId, staffName: "Staff One", countedCash: pre.expectedCash - 10000, countedDenoms: null,
      expectedCash: pre.expectedCash, threshold: 5000, varianceNote: "short", approverId: owner.id, approverName: owner.name,
    });
    expect((await local()).unsynced.orders).toBe(3); // provisional

    net.state.online = true;
    await engine.syncOnce();
    expect(await failures()).toEqual([]);
    const mine = await local();
    expect(mine.unsynced).toEqual({ orders: 0, other: 0 }); // final

    const server = fromServerShiftReport(await asUser<ServerShiftReport>(pg, fx.owner, "select public.shift_report($1) as r", [shift.id]));
    const figures = (r: typeof mine) => ({
      orders: r.orders, grossSales: r.grossSales, discounts: r.discounts, voids: r.voids, refunds: r.refunds, netSales: r.netSales,
      byMethod: r.byMethod, qrAwaiting: r.qrAwaiting, cashIn: r.cashIn, cashOut: r.cashOut, expectedCash: r.expectedCash,
      countedCash: r.countedCash, variance: r.variance, topItems: r.topItems, cashiers: r.cashiers,
    });
    expect(figures(server)).toEqual(figures(mine));
    expect(mine.variance).toBe(-10000);
    expect(server.shift.approvedByName).toBe("Owner I");
  });
});
