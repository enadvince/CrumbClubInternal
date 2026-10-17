import { csvDate, csvMoney, toCsv } from "../csv";
import { KV, type CachedSnapshot, type DeviceInfo, type OutboxOp, type PosDatabase } from "./db";

/**
 * Emergency export: everything this tablet holds, including anything never synced.
 * The last resort if the tablet can never sync again: it is enough to re-enter or
 * replay every order, refund, shift and drawer movement by hand.
 */
export async function buildBackup(db: PosDatabase) {
  const [cached, device, sales, outbox, shifts, drawer, refunds, dismissed] = await Promise.all([
    db.getKv<CachedSnapshot>(KV.snapshot),
    db.getKv<DeviceInfo>(KV.device),
    db.sales.orderBy("createdAt").toArray(),
    db.outbox.toArray(),
    db.shifts.toArray(),
    db.drawer.toArray(),
    db.refunds.toArray(),
    db.getKv<OutboxOp[]>(KV.dismissedOps),
  ]);
  return {
    kind: "crumbclub-pos-emergency-export",
    version: 2,
    exportedAt: new Date().toISOString(),
    device: device ? { deviceId: device.deviceId ?? null, deviceCode: device.deviceCode ?? null, label: device.label ?? null } : null,
    business: cached?.snapshot.business ?? null,
    event: cached?.snapshot.event ?? null,
    /** Not on the server yet (pending, syncing or rejected) */
    unsynced: outbox.filter((o) => o.status !== "synced"),
    /** Rejected entries an owner exported and dismissed from the queue */
    dismissed: dismissed ?? [],
    sales,
    refunds,
    shifts,
    drawer,
  };
}

export async function backupJson(db: PosDatabase): Promise<string> {
  return JSON.stringify(await buildBackup(db), null, 2);
}

/** One row per sold component, so the file stands on its own in a spreadsheet. */
export async function backupCsv(db: PosDatabase): Promise<string> {
  const { sales } = await buildBackup(db);
  const rows: unknown[][] = [];
  for (const s of sales) {
    for (const line of s.payload.lines) {
      for (const c of line.components) {
        rows.push([
          s.id, s.orderNumber ?? "", csvDate(s.createdAt), s.eventId, s.shiftId ?? "", s.staffName, s.status, s.syncedAt ? "yes" : "NO",
          s.paymentMethod, s.paymentStatus ?? "", s.qrReference ?? "", csvMoney(s.payload.total_centavos),
          csvMoney(s.payload.cash_received_centavos), csvMoney(s.payload.discount_centavos || null), s.payload.discount_reason ?? "",
          csvMoney(s.refunded ?? 0), s.voidReason ?? "", line.kind, line.name_snapshot, line.quantity, csvMoney(line.line_total_centavos),
          c.product_id, c.quantity, csvMoney(c.allocated_revenue_centavos),
        ]);
      }
    }
  }
  return toCsv(
    ["client_order_id", "order_number", "created_at", "event_id", "shift_id", "staff", "status", "synced", "payment", "payment_status",
      "qr_reference", "sale_total", "cash_received", "discount", "discount_reason", "refunded", "void_reason", "line_kind", "line_name",
      "line_qty", "line_total", "component_product_id", "component_qty", "component_revenue"],
    rows,
  );
}

/** The rejected queue entries, one row each, with the full data the server refused. */
export function failedOpsCsv(ops: readonly OutboxOp[]): string {
  return toCsv(
    ["queued_at", "type", "op_id", "event_id", "shift_id", "order_number", "amount", "label", "attempts", "server_error", "data_json"],
    ops.map((o) => [
      csvDate(o.createdAt), o.type, o.opId, o.eventId, o.shiftId ?? "", o.display?.orderNumber ?? "", csvMoney(o.display?.amount ?? null),
      o.display?.label ?? "", o.attempts, o.lastError ?? "", JSON.stringify(o.payload),
    ]),
  );
}

/**
 * Takes rejected ("failed") entries off the sync queue so they stop blocking app updates
 * and unpairing. Download failedOpsCsv(ops) first. Only entries that are still failed
 * are removed (one retried meanwhile is left alone). They are kept on the tablet
 * (KV.dismissedOps) and stay in the emergency export. Their stock changes no longer
 * count on this tablet: the server never accepted them.
 */
export async function dismissFailedOps(db: PosDatabase, ops: readonly OutboxOp[]): Promise<number> {
  return db.transaction("rw", db.outbox, db.kv, async () => {
    const still = (await db.outbox.bulkGet(ops.map((o) => o.seq!))).filter((o): o is OutboxOp => o?.status === "failed");
    if (still.length === 0) return 0;
    const kept = (await db.getKv<OutboxOp[]>(KV.dismissedOps)) ?? [];
    await db.setKv(KV.dismissedOps, [...kept, ...still.map((o) => ({ ...o, dismissedAt: Date.now() }))]);
    await db.outbox.bulkDelete(still.map((o) => o.seq!));
    return still.length;
  });
}
