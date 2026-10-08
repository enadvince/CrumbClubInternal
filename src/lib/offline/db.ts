import Dexie, { type Table } from "dexie";
import type { Centavos } from "../money";
import type { SalePayload, Snapshot } from "../pos/types";

/*
 * The tablet's offline store (IndexedDB via Dexie). Store names are kept from v1 so
 * unsynced data survives app updates. How they map to the offline design:
 *   sales      = orders      (full order snapshot: items, prices at sale time, payment, sync status)
 *   outbox     = sync_queue  (one entry per pending write, with attempts, next retry and last error)
 *   kv.snapshot = menu_cache (menu, prices, staff, stock as last pulled, with menuVersion)
 *   kv.device  = device      (device id, device code) and kv.orderCounters (daily counters)
 * Every write lands here first; the sync engine uploads it later.
 */

export type StockEffect = { eventProductId: string; delta: number };

export type OpType =
  | "sale" | "void" | "adjust" | "availability" | "pin_use"
  | "refund" | "audit" | "shift_open" | "shift_close" | "drawer" | "qr_photo";

/** pending → syncing → synced, or failed (rejected by the server; kept for manual review). */
export type OpStatus = "pending" | "syncing" | "synced" | "failed";

export type OutboxOp = {
  seq?: number;
  /** Idempotency key sent to the server (sale id, void key, refund id, audit id...) */
  opId: string;
  type: OpType;
  eventId: string;
  payload: unknown;
  /** Local stock changes this op causes until the server's numbers include it */
  effects: StockEffect[];
  createdAt: number;
  status: OpStatus;
  attempts: number;
  /** Local ms before which this op is not retried (exponential backoff). */
  nextRetryAt?: number;
  lastError?: string;
  /** Local clock (ms) when the server acknowledged the op (display only) */
  syncedAt?: number;
  /** Value of the device's sync counter when the server acknowledged the op */
  ackSeq?: number;
  /** What the sync panel shows for this entry */
  display?: { orderNumber?: string; amount?: Centavos; label?: string };
  /** Shift the op belongs to, so a shift report knows when it is final */
  shiftId?: string;
};

export type PaymentStatus = "paid" | "awaiting_verification" | "verified";

export type LocalSale = {
  id: string;
  eventId: string;
  staffId: string;
  staffName: string;
  createdAt: string;
  total: number;
  paymentMethod: "cash" | "qr_ph";
  qrReference: string | null;
  summary: string;
  status: "completed" | "voided";
  voidReason?: string;
  voidedAt?: string;
  /** ISO time the server acknowledged the sale */
  syncedAt?: string | null;
  payload: SalePayload;
  /** Human-readable number, e.g. T1-261008-0042 (absent on sales made before numbering) */
  orderNumber?: string;
  shiftId?: string | null;
  paymentStatus?: PaymentStatus;
  /** Centavos refunded so far (partial or full refunds, line voids) */
  refunded?: Centavos;
  /** Quantity refunded so far, per sale line id */
  refundedQty?: Record<string, number>;
};

export type CachedSnapshot = {
  snapshot: Snapshot;
  /** Local ms when the pull request started (display only) */
  pulledAt: number;
  /** Sync counter value taken just before the pull request was sent */
  pullSeq: number;
  /** Changes whenever the menu or prices change (hash of the menu part of the snapshot) */
  menuVersion?: string;
};
export type ActiveStaff = { id: string; name: string; role: "owner" | "staff"; unlockedAt: number };

/** This tablet's registration. deviceId/deviceCode come from pos_devices once it has been claimed. */
export type DeviceInfo = { userId: string; deviceId?: string; deviceCode?: string; label?: string };

export type Denominations = Record<string, number>;

export type LocalShift = {
  id: string;
  eventId: string;
  deviceId: string;
  status: "open" | "closed";
  openedAt: string;
  openedByStaffId: string;
  openedByName: string;
  openingFloat: Centavos;
  openingDenoms: Denominations | null;
  closedAt?: string;
  closedByStaffId?: string;
  closedByName?: string;
  countedCash?: Centavos;
  countedDenoms?: Denominations | null;
  expectedCash?: Centavos;
  variance?: Centavos;
  varianceNote?: string | null;
  approvedByStaffId?: string | null;
  approvedByName?: string | null;
};

export type LocalDrawerMovement = {
  id: string;
  shiftId: string;
  kind: "cash_in" | "cash_out";
  amount: Centavos;
  reason: string;
  staffId: string;
  staffName: string;
  approvedByStaffId: string | null;
  createdAt: string;
};

export type LocalRefund = {
  id: string;
  saleId: string;
  orderNumber?: string;
  shiftId: string | null;
  kind: "refund" | "line_void";
  method: "cash" | "qr_ph";
  amount: Centavos;
  lines: { lineId: string; name: string; quantity: number; amount: Centavos }[];
  reason: string;
  note: string | null;
  staffId: string;
  approvedByStaffId: string;
  createdAt: string;
};

/**
 * Optional proof-of-payment photo for a QR sale (compressed JPEG), uploaded to Storage on sync.
 * Stored as bytes rather than a Blob: some WebViews can't keep Blobs in IndexedDB.
 */
export type LocalPhoto = { id: string; saleId: string; bytes: ArrayBuffer; mime: string; createdAt: number; uploadedPath?: string };

export class PosDatabase extends Dexie {
  kv!: Table<{ key: string; value: unknown }, string>;
  sales!: Table<LocalSale, string>;
  outbox!: Table<OutboxOp, number>;
  shifts!: Table<LocalShift, string>;
  drawer!: Table<LocalDrawerMovement, string>;
  refunds!: Table<LocalRefund, string>;
  photos!: Table<LocalPhoto, string>;

  constructor(name = "crumbclub-pos") {
    super(name);
    this.version(1).stores({
      kv: "key",
      sales: "id, eventId, staffId, createdAt, status",
      outbox: "++seq, &opId, status, type, createdAt",
    });
    // v2: order numbers, shifts, drawer movements, refunds, payment photos.
    this.version(2).stores({
      kv: "key",
      sales: "id, eventId, staffId, createdAt, status, orderNumber, shiftId",
      outbox: "++seq, &opId, status, type, createdAt, shiftId",
      shifts: "id, eventId, status, openedAt",
      drawer: "id, shiftId, createdAt",
      refunds: "id, saleId, shiftId, createdAt",
      photos: "id, saleId",
    }).upgrade(async (tx) => {
      // Cash sales were always final; QR sales from v1 were confirmed by staff but never verified.
      await tx.table("sales").toCollection().modify((s: LocalSale) => {
        s.paymentStatus ??= s.paymentMethod === "cash" ? "paid" : "awaiting_verification";
      });
    });
  }

  async getKv<T>(key: string): Promise<T | undefined> {
    return (await this.kv.get(key))?.value as T | undefined;
  }

  async setKv<T>(key: string, value: T): Promise<void> {
    await this.kv.put({ key, value });
  }
}

let instance: PosDatabase | null = null;
export function getDb(): PosDatabase {
  if (!instance) instance = new PosDatabase();
  return instance;
}

export const KV = {
  snapshot: "snapshot",
  activeStaff: "activeStaff",
  lastSyncAt: "lastSyncAt",
  lastSyncError: "lastSyncError",
  syncCounter: "syncCounter",
  /** The tablet's device login, parked while an owner uses owner view on the tablet */
  deviceSession: "deviceSession",
  /** DeviceInfo: the paired login and the claimed device code */
  device: "device",
  /** Per-day order counters: { "261008": 42, ... } */
  orderCounters: "orderCounters",
  /** Owner PIN lockout state on this device */
  pinLock: "pinLock",
  /** Server time minus device time (ms) at the last health check */
  clockOffsetMs: "clockOffsetMs",
} as const;

/** Op statuses that still need the server. */
export const UNSYNCED: readonly OpStatus[] = ["pending", "syncing", "failed"];
