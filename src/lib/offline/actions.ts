import { saleStockEffects } from "../pos/cart";
import type { PaymentPhoto, SalePayload } from "../pos/types";
import { KV, type Denominations, type DeviceInfo, type LocalDrawerMovement, type LocalRefund, type LocalSale, type LocalShift, type OutboxOp, type PosDatabase, type VoidReasonCode } from "./db";
import type { Centavos } from "../money";
import { lineNet, refundAmount, refundStockEffects } from "../pos/refund";
import { uuidv7 } from "../uuid";
import { VOID_REASONS } from "../pos/reasons";
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
  meta: { staffName: string; summary: string; photo?: PaymentPhoto | null; businessId?: string },
  now = Date.now(),
): Promise<LocalSale> {
  return db.transaction("rw", [db.sales, db.outbox, db.kv, db.photos, db.shifts], async () => {
    const { orderNumber, deviceId } = await takeOrderNumber(db, now);
    // Every order belongs to this tablet's open shift (the POS won't sell without one).
    const shift = await openShiftFor(db, draft.event_id);
    const sale: SalePayload = { ...draft, order_number: orderNumber, device_id: deviceId, shift_id: shift?.id ?? null };
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
      shiftId: shift?.id,
    };
    await db.sales.add(local);
    await db.outbox.add(op);
    // The photo uploads after its order (queue order), so the order exists to attach it to.
    if (meta.photo && sale.payment_method === "qr_ph") {
      await db.photos.add({ id: sale.id, saleId: sale.id, bytes: meta.photo.bytes, mime: meta.photo.mime, createdAt: now });
      await db.outbox.add({
        opId: `photo:${sale.id}`,
        type: "qr_photo",
        eventId: sale.event_id,
        payload: { transaction_id: sale.id, photo_id: sale.id, business_id: meta.businessId ?? "" },
        effects: [],
        createdAt: now,
        status: "pending",
        attempts: 0,
        display: { orderNumber, label: "Payment photo" },
      });
    }
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
    shiftId: sale.shift_id ?? null,
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
      display: { orderNumber: sale.orderNumber, amount: sale.total, label: "Undo" },
    });
    await db.outbox.add(auditOp({
      action: "void", transaction_id: saleId, order_number: sale.orderNumber, amount_centavos: sale.total,
      reason: "staff_undo", cashier_staff_id: sale.staffId, manager_staff_id: staffId, shift_id: sale.shiftId ?? null,
    }, sale.eventId, now + 1));
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

// ---------------------------------------------------------------------------
// Owner-approved voids, refunds and the audit log. All work offline: the owner
// PIN is checked on the tablet, and each action is queued with its own client id.
// ---------------------------------------------------------------------------

export type AuditAction =
  | "void" | "void_line" | "refund" | "pin_override" | "cash_in" | "cash_out" | "shift_close_variance"
  | "reports_access" | "export" | "emergency_export" | "pin_lockout";

export type AuditEntry = {
  action: AuditAction;
  transaction_id?: string | null;
  order_number?: string | null;
  refund_id?: string | null;
  shift_id?: string | null;
  items?: unknown;
  amount_centavos?: number | null;
  reason?: string | null;
  note?: string | null;
  cashier_staff_id?: string | null;
  manager_staff_id?: string | null;
};

function auditOp(entry: AuditEntry, eventId: string, now: number): OutboxOp {
  const id = uuidv7(now);
  return {
    opId: `audit:${id}`,
    type: "audit",
    eventId,
    payload: { id, ...entry, device_time: new Date(now).toISOString() },
    effects: [],
    createdAt: now,
    status: "pending",
    attempts: 0,
    shiftId: entry.shift_id ?? undefined,
    display: { orderNumber: entry.order_number ?? undefined, amount: entry.amount_centavos ?? undefined, label: `Audit: ${entry.action}` },
  };
}

/** Queues an audit entry on its own (e.g. reports access, PIN lockout, emergency export). */
export async function auditLocally(db: PosDatabase, entry: AuditEntry, eventId = "", now = Date.now()): Promise<void> {
  await db.outbox.add(auditOp(entry, eventId, now));
}

export { VOID_REASONS };

export class ActionError extends Error {}

/** Voids a whole order. It keeps its number and is shown struck through; stock comes back. */
export async function voidOrderLocally(
  db: PosDatabase,
  args: { saleId: string; reasonCode: VoidReasonCode; note?: string; cashierId: string; approverId: string; shiftId?: string | null },
  now = Date.now(),
): Promise<void> {
  if (args.reasonCode === "other" && !args.note?.trim()) throw new ActionError("Add a note for \"Other\".");
  await db.transaction("rw", db.sales, db.outbox, async () => {
    const sale = await db.sales.get(args.saleId);
    if (!sale) throw new ActionError("Order not found on this tablet");
    if (sale.status === "voided") throw new ActionError("This order is already voided");
    if ((sale.refunded ?? 0) > 0) throw new ActionError("This order already has a refund. Refund the remaining items instead.");
    const label = VOID_REASONS.find((r) => r.code === args.reasonCode)!.label;
    const voidedAt = new Date(now).toISOString();
    await db.sales.update(sale.id, {
      status: "voided", voidedAt, voidReasonCode: args.reasonCode,
      voidReason: `${label}${args.note?.trim() ? `: ${args.note.trim()}` : ""}`,
    });
    await db.outbox.add({
      opId: `void_order:${sale.id}`,
      type: "void_order",
      eventId: sale.eventId,
      payload: {
        transaction_id: sale.id, reason_code: args.reasonCode, note: args.note?.trim() || null,
        staff_id: args.cashierId, approved_by_staff_id: args.approverId, voided_at: voidedAt,
      },
      effects: saleStockEffects(sale.payload).map((e) => ({ eventProductId: e.eventProductId, delta: -e.delta })),
      createdAt: now,
      status: "pending",
      attempts: 0,
      // A void changes the figures of the shift the order was taken in.
      shiftId: sale.shiftId ?? args.shiftId ?? undefined,
      display: { orderNumber: sale.orderNumber, amount: sale.total, label: `Void: ${label}` },
    });
    await db.outbox.add(auditOp({
      action: "void", transaction_id: sale.id, order_number: sale.orderNumber, amount_centavos: sale.total,
      reason: args.reasonCode, note: args.note?.trim() || null, cashier_staff_id: args.cashierId,
      manager_staff_id: args.approverId, shift_id: args.shiftId ?? null,
      items: sale.payload.lines.map((l) => ({ line_id: l.id, name: l.name_snapshot, quantity: l.quantity })),
    }, sale.eventId, now + 1));
  });
}

export type RefundRequest = {
  saleId: string;
  /** "line_void": void items after the order was placed (money goes back the way it came) */
  kind: "refund" | "line_void";
  lines: { lineId: string; quantity: number }[];
  method: "cash" | "qr_ph";
  reasonCode: string;
  note?: string;
  cashierId: string;
  approverId: string;
  shiftId?: string | null;
};

/** Full or partial refund (or line void). Amounts use the same rule as the server. */
export async function refundLocally(db: PosDatabase, req: RefundRequest, now = Date.now()): Promise<LocalRefund> {
  return db.transaction("rw", [db.sales, db.outbox, db.refunds], async () => {
    const sale = await db.sales.get(req.saleId);
    if (!sale) throw new ActionError("Order not found on this tablet");
    if (sale.status === "voided") throw new ActionError("A voided order can't be refunded");
    const refundedLines = { ...(sale.refundedLines ?? {}) };
    const lines: LocalRefund["lines"] = [];
    const effects: OutboxOp["effects"] = [];
    for (const { lineId, quantity } of req.lines) {
      if (quantity <= 0) continue;
      const line = sale.payload.lines.find((l) => l.id === lineId);
      if (!line) throw new ActionError("Item is not on this order");
      const prev = refundedLines[lineId] ?? { qty: 0, amount: 0 };
      if (prev.qty + quantity > line.quantity) throw new ActionError(`Only ${line.quantity - prev.qty} ${line.name_snapshot} left to refund`);
      const amount = refundAmount(lineNet(line), line.quantity, prev.qty, prev.amount, quantity);
      refundedLines[lineId] = { qty: prev.qty + quantity, amount: prev.amount + amount };
      lines.push({ lineId, name: line.name_snapshot, quantity, amount });
      effects.push(...refundStockEffects(line, quantity));
    }
    if (lines.length === 0) throw new ActionError("Pick at least one item");
    const amount = lines.reduce((s, l) => s + l.amount, 0);
    if (amount <= 0) throw new ActionError("Nothing left to refund on those items");

    const id = uuidv7(now);
    const refund: LocalRefund = {
      id, saleId: sale.id, orderNumber: sale.orderNumber, shiftId: req.shiftId ?? null, kind: req.kind, method: req.method,
      amount, lines, reason: req.reasonCode, note: req.note?.trim() || null, staffId: req.cashierId,
      approvedByStaffId: req.approverId, createdAt: new Date(now).toISOString(),
    };
    await db.refunds.add(refund);
    await db.sales.update(sale.id, { refunded: (sale.refunded ?? 0) + amount, refundedLines });
    await db.outbox.add({
      opId: `refund:${id}`,
      type: "refund",
      eventId: sale.eventId,
      payload: {
        id, transaction_id: sale.id, kind: req.kind, method: req.method, reason_code: req.reasonCode,
        note: refund.note, staff_id: req.cashierId, approved_by_staff_id: req.approverId, shift_id: req.shiftId ?? null,
        created_at: refund.createdAt, amount_centavos: amount,
        lines: lines.map((l) => ({ transaction_line_id: l.lineId, quantity: l.quantity, amount_centavos: l.amount })),
      },
      effects,
      createdAt: now,
      status: "pending",
      attempts: 0,
      shiftId: req.shiftId ?? undefined,
      display: { orderNumber: sale.orderNumber, amount, label: req.kind === "line_void" ? "Item void" : "Refund" },
    });
    await db.outbox.add(auditOp({
      action: req.kind === "line_void" ? "void_line" : "refund", transaction_id: sale.id, order_number: sale.orderNumber,
      refund_id: id, amount_centavos: amount, reason: req.reasonCode, note: refund.note, cashier_staff_id: req.cashierId,
      manager_staff_id: req.approverId, shift_id: req.shiftId ?? null,
      items: lines.map((l) => ({ line_id: l.lineId, name: l.name, quantity: l.quantity, amount_centavos: l.amount })),
    }, sale.eventId, now + 1));
    return refund;
  });
}

// ---------------------------------------------------------------------------
// Shifts and the cash drawer (one open shift per tablet). All offline.
// ---------------------------------------------------------------------------

export async function openShiftFor(db: PosDatabase, eventId: string): Promise<LocalShift | undefined> {
  return db.shifts.where("status").equals("open").filter((s) => s.eventId === eventId).first();
}

export async function openShiftLocally(
  db: PosDatabase,
  args: { eventId: string; staffId: string; staffName: string; openingFloat: Centavos; openingDenoms: Denominations | null },
  now = Date.now(),
): Promise<LocalShift> {
  if (!Number.isInteger(args.openingFloat) || args.openingFloat < 0) throw new ActionError("Enter the opening float");
  return db.transaction("rw", [db.shifts, db.outbox, db.kv], async () => {
    const device = await db.getKv<DeviceInfo>(KV.device);
    if (!device?.deviceId) throw new ActionError("This tablet isn't registered yet");
    const open = await db.shifts.where("status").equals("open").first();
    if (open) throw new ActionError("A shift is already open on this tablet. Close it first.");
    const shift: LocalShift = {
      id: uuidv7(now), eventId: args.eventId, deviceId: device.deviceId, status: "open", openedAt: new Date(now).toISOString(),
      openedByStaffId: args.staffId, openedByName: args.staffName, openingFloat: args.openingFloat, openingDenoms: args.openingDenoms,
    };
    await db.shifts.add(shift);
    await db.outbox.add({
      opId: `shift_open:${shift.id}`,
      type: "shift_open",
      eventId: args.eventId,
      payload: {
        id: shift.id, event_id: args.eventId, opened_at: shift.openedAt, opened_by_staff_id: args.staffId,
        opening_float_centavos: args.openingFloat, opening_denoms: args.openingDenoms,
      },
      effects: [],
      createdAt: now,
      status: "pending",
      attempts: 0,
      shiftId: shift.id,
      display: { amount: args.openingFloat, label: "Shift opened" },
    });
    return shift;
  });
}

/** Cash in (e.g. extra float) or cash out (e.g. supplier pay-out, needs an owner). */
export async function drawerMovementLocally(
  db: PosDatabase,
  args: { shiftId: string; kind: "cash_in" | "cash_out"; amount: Centavos; reason: string; staffId: string; staffName: string; approverId?: string | null },
  now = Date.now(),
): Promise<LocalDrawerMovement> {
  if (!Number.isInteger(args.amount) || args.amount <= 0) throw new ActionError("Enter an amount");
  if (!args.reason.trim()) throw new ActionError("Enter a reason");
  if (args.kind === "cash_out" && !args.approverId) throw new ActionError("Cash out needs an owner PIN");
  return db.transaction("rw", [db.shifts, db.drawer, db.outbox], async () => {
    const shift = await db.shifts.get(args.shiftId);
    if (!shift || shift.status !== "open") throw new ActionError("No open shift");
    const m: LocalDrawerMovement = {
      id: uuidv7(now), shiftId: shift.id, kind: args.kind, amount: args.amount, reason: args.reason.trim(),
      staffId: args.staffId, staffName: args.staffName, approvedByStaffId: args.approverId ?? null, createdAt: new Date(now).toISOString(),
    };
    await db.drawer.add(m);
    await db.outbox.add({
      opId: `drawer:${m.id}`,
      type: "drawer",
      eventId: shift.eventId,
      payload: {
        id: m.id, shift_id: shift.id, kind: m.kind, amount_centavos: m.amount, reason: m.reason, staff_id: m.staffId,
        approved_by_staff_id: m.approvedByStaffId, created_at: m.createdAt,
      },
      effects: [],
      createdAt: now,
      status: "pending",
      attempts: 0,
      shiftId: shift.id,
      display: { amount: m.amount, label: m.kind === "cash_in" ? `Cash in: ${m.reason}` : `Cash out: ${m.reason}` },
    });
    await db.outbox.add(auditOp({
      action: m.kind, amount_centavos: m.amount, reason: m.reason, cashier_staff_id: m.staffId,
      manager_staff_id: m.approvedByStaffId, shift_id: shift.id,
    }, shift.eventId, now + 1));
    return m;
  });
}

/**
 * Closes the shift after a blind count. Allowed offline and with orders still unsynced:
 * the report is then provisional until they sync.
 */
export async function closeShiftLocally(
  db: PosDatabase,
  args: {
    shiftId: string; staffId: string; staffName: string; countedCash: Centavos; countedDenoms: Denominations | null;
    expectedCash: Centavos; threshold: Centavos; varianceNote?: string; approverId?: string | null; approverName?: string | null;
  },
  now = Date.now(),
): Promise<LocalShift> {
  const variance = args.countedCash - args.expectedCash;
  const needsApproval = Math.abs(variance) > args.threshold;
  if (needsApproval && !args.approverId) throw new ActionError("This variance needs an owner PIN");
  if (needsApproval && !args.varianceNote?.trim()) throw new ActionError("Add a note explaining the variance");
  return db.transaction("rw", [db.shifts, db.outbox], async () => {
    const shift = await db.shifts.get(args.shiftId);
    if (!shift || shift.status !== "open") throw new ActionError("No open shift to close");
    const closedAt = new Date(now).toISOString();
    const patch: Partial<LocalShift> = {
      status: "closed", closedAt, closedByStaffId: args.staffId, closedByName: args.staffName, countedCash: args.countedCash,
      countedDenoms: args.countedDenoms, expectedCash: args.expectedCash, variance, varianceNote: args.varianceNote?.trim() || null,
      approvedByStaffId: args.approverId ?? null, approvedByName: args.approverName ?? null,
    };
    await db.shifts.update(shift.id, patch);
    await db.outbox.add({
      opId: `shift_close:${shift.id}`,
      type: "shift_close",
      eventId: shift.eventId,
      payload: {
        id: shift.id, closed_at: closedAt, closed_by_staff_id: args.staffId, counted_cash_centavos: args.countedCash,
        counted_denoms: args.countedDenoms, expected_cash_centavos: args.expectedCash, variance_note: patch.varianceNote,
        approved_by_staff_id: args.approverId ?? null,
      },
      effects: [],
      createdAt: now,
      status: "pending",
      attempts: 0,
      shiftId: shift.id,
      display: { amount: args.countedCash, label: "Shift closed" },
    });
    if (needsApproval) {
      await db.outbox.add(auditOp({
        action: "shift_close_variance", amount_centavos: variance, note: patch.varianceNote, cashier_staff_id: args.staffId,
        manager_staff_id: args.approverId ?? null, shift_id: shift.id,
      }, shift.eventId, now + 1));
    }
    return { ...shift, ...patch } as LocalShift;
  });
}

/** Entries for a shift still waiting for the server (for the "Provisional" marker). */
export async function unsyncedForShift(db: PosDatabase, shiftId: string): Promise<{ orders: number; other: number }> {
  const ops = await db.outbox.where("shiftId").equals(shiftId).filter((o) => o.status !== "synced").toArray();
  const orders = ops.filter((o) => o.type === "sale").length;
  return { orders, other: ops.length - orders };
}
