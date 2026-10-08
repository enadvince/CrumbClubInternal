import type { SalePayload, Snapshot } from "../pos/types";
import { KV, type CachedSnapshot, type OutboxOp, type PosDatabase } from "./db";
import { isReflected, summarizeOutbox } from "./stock";
import { applyDeviceState } from "./numbering";

/** A failed network call. `permanent` = the server rejected the data (retrying won't help). */
export class SyncError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = "SyncError";
  }
}

export type PinUseAction = "sign_in" | "owner_menu" | "owner_view" | "void_approval";
export type PinUsePayload = { id: string; staff_id: string; action: PinUseAction; used_at: string };

export interface SyncTransport {
  recordSale(sale: SalePayload): Promise<void>;
  voidSale(args: { transaction_id: string; reason: string; staff_id: string; voided_at: string }): Promise<void>;
  adjustStock(payload: Record<string, unknown>): Promise<void>;
  setAvailability(args: { event_product_id: string; available: boolean }): Promise<void>;
  logPinUse(use: PinUsePayload): Promise<void>;
  fetchSnapshot(eventId: string | null): Promise<Snapshot>;
  heartbeat(unsyncedCount: number, oldestUnsyncedAt: string | null): Promise<void>;
  /** Claims (or returns) this tablet's device code. Needs the internet. */
  claimDeviceCode(label?: string): Promise<ClaimedDevice>;
  /** Lightweight health check: the API answers and the login works. Returns the server clock. */
  ping(): Promise<{ server_time: string }>;
}

export type ClaimedDevice = { device_id: string; device_code: string; label: string | null };

export type SyncState = {
  syncing: boolean;
  online: boolean;
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export type SyncResult = { ok: boolean; pushed: number; failedPermanently: number; error?: string };

const PRUNE_AFTER_MS = 6 * 60 * 60 * 1000;
const BASE_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Pushes the outbox to Supabase in order, then pulls a fresh snapshot.
 * - Every op carries a client id, so a retry after a lost response is a no-op server side.
 * - A transient failure (offline, timeout, 5xx) stops the push; the op stays pending.
 * - A permanent rejection marks the op "failed" (kept, shown to the owner, included in backups).
 */
export class SyncEngine {
  private running: Promise<SyncResult> | null = null;
  private listeners = new Set<(s: SyncState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  state: SyncState = { syncing: false, online: true, lastSyncAt: null, lastAttemptAt: null, lastError: null, consecutiveFailures: 0 };

  constructor(
    private readonly db: PosDatabase,
    private readonly transport: SyncTransport,
    private readonly now: () => number = () => Date.now(),
    private readonly isOnline: () => boolean = () => (typeof navigator === "undefined" ? true : navigator.onLine),
  ) {}

  subscribe(fn: (s: SyncState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private setState(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /** Runs one push + pull cycle. Concurrent callers share the same run. */
  syncOnce(): Promise<SyncResult> {
    if (!this.running) {
      this.running = this.run().finally(() => { this.running = null; });
    }
    return this.running;
  }

  /** Next value of the persisted monotonic sync counter. */
  private async nextSeq(): Promise<number> {
    const next = ((await this.db.getKv<number>(KV.syncCounter)) ?? 0) + 1;
    await this.db.setKv(KV.syncCounter, next);
    return next;
  }

  private async run(): Promise<SyncResult> {
    const online = this.isOnline();
    this.setState({ online, lastAttemptAt: this.now() });
    if (!online) return { ok: false, pushed: 0, failedPermanently: 0, error: "offline" };

    this.setState({ syncing: true });
    let pushed = 0;
    let failedPermanently = 0;
    try {
      const pending = await this.db.outbox.where("status").equals("pending").sortBy("seq");
      for (const op of pending) {
        try {
          await this.send(op);
          const syncedAt = this.now();
          await this.db.transaction("rw", this.db.outbox, this.db.sales, this.db.kv, async () => {
            const ackSeq = await this.nextSeq();
            await this.db.outbox.update(op.seq!, { status: "synced", syncedAt, ackSeq, lastError: undefined });
            if (op.type === "sale") await this.db.sales.update(op.opId, { syncedAt: new Date(syncedAt).toISOString() });
          });
          pushed++;
        } catch (err) {
          const e = toSyncError(err);
          await this.db.outbox.update(op.seq!, {
            attempts: op.attempts + 1,
            lastError: e.message,
            ...(e.permanent ? { status: "failed" as const } : {}),
          });
          if (!e.permanent) throw e;
          failedPermanently++;
        }
      }

      await this.pull();
      await this.sendHeartbeat();
      await this.prune();
      const t = this.now();
      await this.db.setKv(KV.lastSyncAt, t);
      this.setState({ syncing: false, online: true, lastSyncAt: t, lastError: null, consecutiveFailures: 0 });
      return { ok: true, pushed, failedPermanently };
    } catch (err) {
      const e = toSyncError(err);
      this.setState({ syncing: false, lastError: e.message, consecutiveFailures: this.state.consecutiveFailures + 1 });
      return { ok: false, pushed, failedPermanently, error: e.message };
    }
  }

  private async send(op: OutboxOp) {
    switch (op.type) {
      case "sale":
        return this.transport.recordSale(op.payload as SalePayload);
      case "void":
        return this.transport.voidSale(op.payload as Parameters<SyncTransport["voidSale"]>[0]);
      case "adjust":
        return this.transport.adjustStock(op.payload as Record<string, unknown>);
      case "availability":
        return this.transport.setAvailability(op.payload as Parameters<SyncTransport["setAvailability"]>[0]);
      case "pin_use":
        return this.transport.logPinUse(op.payload as PinUsePayload);
    }
  }

  /** Fetches the menu, prices, server stock and staff, and applies owner voids locally. */
  async pull(): Promise<void> {
    const cached = await this.db.getKv<CachedSnapshot>(KV.snapshot);
    const pulledAt = this.now();
    const pullSeq = await this.nextSeq();
    let snapshot = await this.transport.fetchSnapshot(null);
    // No live event: keep showing the current one (e.g. just closed) so its state is accurate.
    if (!snapshot.event && cached?.snapshot.event) {
      snapshot = await this.transport.fetchSnapshot(cached.snapshot.event.id);
    }
    await this.db.setKv<CachedSnapshot>(KV.snapshot, { snapshot, pulledAt, pullSeq });
    await applyDeviceState(this.db, snapshot.device, this.now());

    const voided = new Set(snapshot.voided_transaction_ids ?? []);
    if (voided.size > 0) {
      await this.db.sales
        .where("id").anyOf([...voided])
        .and((s) => s.status === "completed")
        .modify({ status: "voided", voidReason: "voided by owner" });
    }
  }

  private async sendHeartbeat() {
    try {
      const summary = summarizeOutbox(await this.db.outbox.where("status").notEqual("synced").toArray());
      await this.transport.heartbeat(
        summary.unsyncedSales,
        summary.oldestUnsyncedAt ? new Date(summary.oldestUnsyncedAt).toISOString() : null,
      );
    } catch {
      // Best effort only.
    }
  }

  /** Drops synced ops once the server snapshot includes them and they're old. Sales are kept. */
  private async prune() {
    const cached = await this.db.getKv<CachedSnapshot>(KV.snapshot);
    if (!cached) return;
    const cutoff = this.now() - PRUNE_AFTER_MS;
    await this.db.outbox
      .where("status").equals("synced")
      .and((op) => isReflected(op, cached.pullSeq) && op.createdAt < cutoff)
      .delete();
  }

  /** Background loop: every 15 s, sooner when the connection returns, backing off on failures. */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
      document.addEventListener("visibilitychange", this.onVisible);
    }
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
      document.removeEventListener("visibilitychange", this.onVisible);
    }
  }

  /** Ask for a sync soon (e.g. right after a checkout). */
  requestSync() {
    this.schedule(300);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.syncOnce();
      const failures = this.state.consecutiveFailures;
      const next = failures === 0 ? BASE_INTERVAL_MS : Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (failures - 1));
      this.schedule(next);
    }, delay);
  }

  private onOnline = () => {
    this.setState({ online: true, consecutiveFailures: 0 });
    this.schedule(0);
  };
  private onOffline = () => this.setState({ online: false });
  private onVisible = () => {
    if (document.visibilityState === "visible") this.schedule(0);
  };
}

export function toSyncError(err: unknown): SyncError {
  if (err instanceof SyncError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SyncError(message, false);
}
