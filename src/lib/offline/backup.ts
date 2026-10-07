import { toCsv } from "../csv";
import { centavosToDecimalString } from "../money";
import { KV, type CachedSnapshot, type PosDatabase } from "./db";

/**
 * Everything the tablet knows that might not be on the server yet: every
 * local sale with its full payload, and every queued op. Enough to re-enter
 * sales by hand (or replay them) if the tablet can't sync.
 */
export async function buildBackup(db: PosDatabase) {
  const [cached, sales, outbox] = await Promise.all([
    db.getKv<CachedSnapshot>(KV.snapshot),
    db.sales.orderBy("createdAt").toArray(),
    db.outbox.toArray(),
  ]);
  return {
    kind: "crumbclub-pos-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    business: cached?.snapshot.business ?? null,
    event: cached?.snapshot.event ?? null,
    unsynced: outbox.filter((o) => o.status !== "synced"),
    sales,
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
          s.id, s.createdAt, s.eventId, s.staffName, s.status, s.syncedAt ? "yes" : "NO",
          s.paymentMethod, s.qrReference ?? "", centavosToDecimalString(s.payload.total_centavos),
          s.payload.cash_received_centavos != null ? centavosToDecimalString(s.payload.cash_received_centavos) : "",
          s.payload.discount_centavos ? centavosToDecimalString(s.payload.discount_centavos) : "", s.payload.discount_reason ?? "",
          line.kind, line.name_snapshot, line.quantity, centavosToDecimalString(line.line_total_centavos),
          c.product_id, c.quantity, centavosToDecimalString(c.allocated_revenue_centavos),
        ]);
      }
    }
  }
  return toCsv(
    ["sale_id", "created_at", "event_id", "staff", "status", "synced", "payment", "qr_reference", "sale_total",
      "cash_received", "discount", "discount_reason", "line_kind", "line_name", "line_qty", "line_total",
      "component_product_id", "component_qty", "component_revenue"],
    rows,
  );
}
