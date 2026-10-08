import { saleStockEffects } from "../pos/cart";
import type { SalePayload } from "../pos/types";
import type { LocalSale, OutboxOp, PosDatabase } from "./db";
import type { PinUseAction } from "./sync";
import { takeOrderNumber } from "./numbering";

export const UNDO_WINDOW_MS = 60_000;

/**
 * Records a sale on the device. One IndexedDB transaction takes the next order
 * number, writes the sale and queues it for sync, so a sale is never half-saved
 * and a number is never reused, even after a crash. No network involved.
 */
export async function recordSaleLocally(
  db: PosDatabase,
  draft: SalePayload,
  meta: { staffName: string; summary: string },
  now = Date.now(),
): Promise<LocalSale> {
  return db.transaction("rw", db.sales, db.outbox, db.kv, async () => {
    const { orderNumber, deviceId } = await takeOrderNumber(db, now);
    const sale: SalePayload = { ...draft, order_number: orderNumber, device_id: deviceId };
    const local = localSaleFrom(sale, meta);
    const op: OutboxOp = {
      opId: sale.id,
      type: "sale",
      eventId: sale.event_id,
      payload: sale,
      effects: saleStockEffects(sale),
      createdAt: now,
      status: "pending",
      attempts: 0,
      display: { orderNumber, amount: sale.total_centavos, label: meta.summary },
    };
    await db.sales.add(local);
    await db.outbox.add(op);
    return local;
  });
}

function localSaleFrom(sale: SalePayload, meta: { staffName: string; summary: string }): LocalSale {
  return {
    id: sale.id,
    orderNumber: sale.order_number,
    eventId: sale.event_id,
    staffId: sale.staff_id,
    staffName: meta.staffName,
    createdAt: sale.client_created_at,
    total: sale.total_centavos,
    paymentMethod: sale.payment_method,
    qrReference: sale.qr_reference,
    summary: meta.summary,
    status: "completed",
    syncedAt: null,
    payload: sale,
    paymentStatus: sale.payment_method === "cash" ? "paid" : "awaiting_verification",
  };
}

export class UndoError extends Error {}

/** "Undo last sale": voids with reason "staff undo" within 60 s and returns the stock. */
export async function undoSale(db: PosDatabase, saleId: string, staffId: string, now = Date.now()): Promise<void> {
  await db.transaction("rw", db.sales, db.outbox, async () => {
    const sale = await db.sales.get(saleId);
    if (!sale) throw new UndoError("Sale not found");
    if (sale.status === "voided") throw new UndoError("Sale was already undone");
    if (now - new Date(sale.createdAt).getTime() > UNDO_WINDOW_MS) throw new UndoError("Undo is only available for 60 seconds");
    const voidedAt = new Date(now).toISOString();
    await db.sales.update(saleId, { status: "voided", voidReason: "staff undo", voidedAt });
    await db.outbox.add({
      opId: `void:${saleId}`,
      type: "void",
      eventId: sale.eventId,
      payload: { transaction_id: saleId, reason: "staff undo", staff_id: staffId, voided_at: voidedAt },
      effects: saleStockEffects(sale.payload).map((e) => ({ eventProductId: e.eventProductId, delta: -e.delta })),
      createdAt: now,
      status: "pending",
      attempts: 0,
    });
  });
}

export type AdjustmentReason = "restock" | "waste" | "staff_meal" | "giveaway" | "correction";

/** Stock adjustment made on the tablet (owner menu). Queued like a sale. */
export async function adjustStockLocally(
  db: PosDatabase,
  args: { eventId: string; eventProductId: string; quantityChange: number; reason: AdjustmentReason; note?: string; staffId: string },
  now = Date.now(),
): Promise<void> {
  const id = crypto.randomUUID();
  await db.outbox.add({
    opId: id,
    type: "adjust",
    eventId: args.eventId,
    payload: {
      id, event_product_id: args.eventProductId, quantity_change: args.quantityChange, reason: args.reason,
      note: args.note ?? null, staff_id: args.staffId, created_at: new Date(now).toISOString(),
    },
    effects: [{ eventProductId: args.eventProductId, delta: args.quantityChange }],
    createdAt: now,
    status: "pending",
    attempts: 0,
  });
}

export async function setAvailabilityLocally(db: PosDatabase, eventId: string, eventProductId: string, available: boolean, now = Date.now()) {
  await db.outbox.add({
    opId: crypto.randomUUID(),
    type: "availability",
    eventId,
    payload: { event_product_id: eventProductId, available },
    effects: [],
    createdAt: now,
    status: "pending",
    attempts: 0,
  });
}

/** Records that a PIN was used (sign in, owner menu, void approval). Queued like a sale, so it works offline. */
export async function logPinUseLocally(db: PosDatabase, staffId: string, action: PinUseAction, eventId = "", now = Date.now()) {
  const id = crypto.randomUUID();
  await db.outbox.add({
    opId: id,
    type: "pin_use",
    eventId,
    payload: { id, staff_id: staffId, action, used_at: new Date(now).toISOString() },
    effects: [],
    createdAt: now,
    status: "pending",
    attempts: 0,
  });
}

/** QR Ph reference already used? Checks local sales and the refs pulled from the server. */
export async function isDuplicateQrRef(db: PosDatabase, reference: string, serverRefs: readonly string[]): Promise<boolean> {
  const ref = reference.trim();
  if (!ref) return false;
  if (serverRefs.includes(ref)) return true;
  return (await db.sales.filter((s) => s.qrReference === ref && s.status === "completed").count()) > 0;
}
