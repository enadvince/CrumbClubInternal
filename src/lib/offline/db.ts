import Dexie, { type Table } from "dexie";
import type { SalePayload, Snapshot } from "../pos/types";

export type StockEffect = { eventProductId: string; delta: number };

export type OutboxOp = {
  seq?: number;
  /** Idempotency key sent to the server (sale id, void key, adjustment id) */
  opId: string;
  type: "sale" | "void" | "adjust" | "availability";
  eventId: string;
  payload: unknown;
  /** Local stock changes this op causes until the server's numbers include it */
  effects: StockEffect[];
  createdAt: number;
  status: "pending" | "synced" | "failed";
  attempts: number;
  lastError?: string;
  /** Local clock (ms) when the server acknowledged the op (display only) */
  syncedAt?: number;
  /** Value of the device's sync counter when the server acknowledged the op */
  ackSeq?: number;
};

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
};

export type CachedSnapshot = {
  snapshot: Snapshot;
  /** Local ms when the pull request started (display only) */
  pulledAt: number;
  /** Sync counter value taken just before the pull request was sent */
  pullSeq: number;
};
export type ActiveStaff = { id: string; name: string; role: "owner" | "staff"; unlockedAt: number };

export class PosDatabase extends Dexie {
  kv!: Table<{ key: string; value: unknown }, string>;
  sales!: Table<LocalSale, string>;
  outbox!: Table<OutboxOp, number>;

  constructor(name = "crumbclub-pos") {
    super(name);
    this.version(1).stores({
      kv: "key",
      sales: "id, eventId, staffId, createdAt, status",
      outbox: "++seq, &opId, status, type, createdAt",
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
} as const;
