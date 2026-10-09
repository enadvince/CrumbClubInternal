import type { CachedSnapshot, OutboxOp } from "./db";

/**
 * Whether the server's numbers in this snapshot already include an op.
 * An op is reflected only if the server acknowledged it before the snapshot
 * request was sent; otherwise its effect is still applied locally.
 * Uses a monotonic per-device counter, not the wall clock, so equal
 * timestamps or a tablet clock change can't cause double counting.
 */
export function isReflected(op: OutboxOp, pullSeq: number): boolean {
  return op.status === "synced" && op.ackSeq !== undefined && op.ackSeq < pullSeq;
}

/**
 * Live stock on the tablet = the server's stock from the last snapshot
 * + every local change the server hadn't seen yet when that snapshot was taken.
 * Failed ops still count: the pastry physically left the counter.
 */
export function localStock(cached: CachedSnapshot | undefined, ops: readonly OutboxOp[]): Map<string, number> {
  const stock = new Map<string, number>();
  if (!cached?.snapshot.event) return stock;
  for (const p of cached.snapshot.products ?? []) stock.set(p.event_product_id, p.stock);
  for (const op of ops) {
    if (op.eventId !== cached.snapshot.event.id || isReflected(op, cached.pullSeq)) continue;
    for (const e of op.effects) {
      if (stock.has(e.eventProductId)) stock.set(e.eventProductId, stock.get(e.eventProductId)! + e.delta);
    }
  }
  return stock;
}

/** Availability toggles made on the tablet that the snapshot doesn't include yet (last one wins). */
export function localAvailability(cached: CachedSnapshot | undefined, ops: readonly OutboxOp[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!cached) return out;
  for (const op of ops) {
    if (op.type !== "availability" || isReflected(op, cached.pullSeq)) continue;
    const p = op.payload as { event_product_id: string; available: boolean };
    out.set(p.event_product_id, p.available);
  }
  return out;
}

export type UnsyncedSummary = {
  /** Entries waiting or being sent (any type) */
  pending: number;
  /** Entries the server rejected (any type) */
  failed: number;
  /** Orders not yet on the server (pending, syncing or failed) */
  unsyncedSales: number;
  pendingSales: number;
  failedSales: number;
  oldestUnsyncedAt: number | null;
};

export function summarizeOutbox(ops: readonly OutboxOp[]): UnsyncedSummary {
  let pending = 0;
  let failed = 0;
  let unsyncedSales = 0;
  let pendingSales = 0;
  let failedSales = 0;
  let oldest: number | null = null;
  for (const op of ops) {
    if (op.status === "synced") continue;
    const isSale = op.type === "sale";
    if (op.status === "failed") {
      failed++;
      if (isSale) failedSales++;
    } else {
      pending++; // pending or syncing
      if (isSale) pendingSales++;
    }
    if (isSale) unsyncedSales++;
    if (oldest === null || op.createdAt < oldest) oldest = op.createdAt;
  }
  return { pending, failed, unsyncedSales, pendingSales, failedSales, oldestUnsyncedAt: oldest };
}

export const STALE_UNSYNCED_MS = 30 * 60 * 1000;
