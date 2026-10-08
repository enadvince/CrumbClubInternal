import type { SalePayload, Snapshot } from "../pos/types";
import { KV, type CachedSnapshot, type OutboxOp, type PosDatabase } from "./db";
import { isReflected, summarizeOutbox } from "./stock";
import { applyDeviceState } from "./numbering";
import { backoffDelay } from "./backoff";

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
  /** Uploads a QR payment photo to Storage and links it to its order. Idempotent. */
  uploadPaymentPhoto(args: PhotoUpload): Promise<void>;
}

export type PhotoUpload = { transactionId: string; businessId: string; bytes: ArrayBuffer; mime: string };
export type PhotoOpPayload = { transaction_id: string; photo_id: string; business_id: string };

export type ClaimedDevice = { device_id: string; device_code: string; label: string | null };

export type SyncState = {
  /** Confirmed by a health check, not just navigator.onLine */
  online: boolean;
  syncing: boolean;
  /** How many queue entries the current run is sending */
  syncingCount: number;
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Server clock minus this tablet's clock, from the last health check */
  clockOffsetMs: number | null;
};

export type SyncResult = { ok: boolean; pushed: number; failedPermanently: number; skipped?: boolean; error?: string };

const PRUNE_AFTER_MS = 6 * 60 * 60 * 1000;
/** While anything is waiting: look again at least this often. */
export const PENDING_INTERVAL_MS = 30_000;
/** Nothing waiting: refresh the menu and stock this often. */
export const IDLE_INTERVAL_MS = 60_000;
const LOCK_NAME = "crumbclub-sync";

type LockManagerLike = {
  request<T>(name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<T>): Promise<T>;
};

function browserLocks(): LockManagerLike | null {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
  return navigator.locks as unknown as LockManagerLike;
}

/**
 * Pushes the queue to Supabase in creation order, then pulls a fresh snapshot.
 *  - Every entry carries a client id, so re-sending after a lost response is a no-op on the server.
 *  - States: pending, syncing (being sent), synced, failed (rejected; kept and shown for review).
 *  - A retryable failure (offline, timeout, 5xx, 429) keeps the entry pending with exponential
 *    backoff and stops the push, so later entries never overtake it.
 *  - Only one sync runs at a time across tabs (Web Locks), and connectivity is confirmed with
 *    a health check instead of trusting navigator.onLine.
 */
export class SyncEngine {
  private running: Promise<SyncResult> | null = null;
  private listeners = new Set<(s: SyncState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  state: SyncState = {
    online: true, syncing: false, syncingCount: 0, lastSyncAt: null, lastAttemptAt: null, lastError: null,
    consecutiveFailures: 0, clockOffsetMs: null,
  };

  constructor(
    private readonly db: PosDatabase,
    private readonly transport: SyncTransport,
    private readonly now: () => number = () => Date.now(),
    private readonly isOnline: () => boolean = () => (typeof navigator === "undefined" ? true : navigator.onLine),
    private readonly random: () => number = Math.random,
    private readonly locks: LockManagerLike | null = browserLocks(),
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

  /** Runs one push + pull cycle. Concurrent callers in this tab share the same run. */
  syncOnce(): Promise<SyncResult> {
    if (!this.running) {
      this.running = this.withLock().finally(() => { this.running = null; });
    }
    return this.running;
  }

  /** Another tab already syncing? Then skip; it will send everything. */
  private withLock(): Promise<SyncResult> {
    if (!this.locks) return this.run();
    return this.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return { ok: true, pushed: 0, failedPermanently: 0, skipped: true };
      return this.run();
    });
  }

  /** Next value of the persisted monotonic sync counter. */
  private async nextSeq(): Promise<number> {
    const next = ((await this.db.getKv<number>(KV.syncCounter)) ?? 0) + 1;
    await this.db.setKv(KV.syncCounter, next);
    return next;
  }

  /** Confirms we can actually reach the server (navigator.onLine can't be trusted alone). */
  private async checkConnection(): Promise<boolean> {
    if (!this.isOnline()) return false;
    try {
      const before = this.now();
      const { server_time } = await this.transport.ping();
      const after = this.now();
      const offset = Date.parse(server_time) - Math.round((before + after) / 2);
      if (Number.isFinite(offset)) {
        await this.db.setKv(KV.clockOffsetMs, offset);
        this.setState({ clockOffsetMs: offset });
      }
      return true;
    } catch {
      return false;
    }
  }

  private async run(): Promise<SyncResult> {
    this.setState({ lastAttemptAt: this.now() });
    // We hold the lock, so anything still marked "syncing" was interrupted (tab closed, crash).
    await this.db.outbox.where("status").equals("syncing").modify({ status: "pending" });

    const online = await this.checkConnection();
    this.setState({ online });
    if (!online) return { ok: false, pushed: 0, failedPermanently: 0, error: "offline" };

    let pushed = 0;
    let failedPermanently = 0;
    try {
      const pending = await this.db.outbox.where("status").equals("pending").sortBy("seq");
      this.setState({ syncing: true, syncingCount: pending.length });
      for (const op of pending) {
        // Keep creation order: an entry still backing off holds back the ones after it.
        if (op.nextRetryAt && op.nextRetryAt > this.now()) break;
        await this.db.outbox.update(op.seq!, { status: "syncing" });
        try {
          await this.send(op);
          const syncedAt = this.now();
          await this.db.transaction("rw", this.db.outbox, this.db.sales, this.db.kv, async () => {
            const ackSeq = await this.nextSeq();
            await this.db.outbox.update(op.seq!, { status: "synced", syncedAt, ackSeq, lastError: undefined, nextRetryAt: undefined });
            if (op.type === "sale") await this.db.sales.update(op.opId, { syncedAt: new Date(syncedAt).toISOString() });
          });
          pushed++;
          this.setState({ syncingCount: Math.max(0, this.state.syncingCount - 1) });
        } catch (err) {
          const e = toSyncError(err);
          const attempts = op.attempts + 1;
          await this.db.outbox.update(op.seq!, e.permanent
            ? { status: "failed", attempts, lastError: e.message, nextRetryAt: undefined }
            : { status: "pending", attempts, lastError: e.message, nextRetryAt: this.now() + backoffDelay(attempts, this.random) });
          if (!e.permanent) throw e;
          failedPermanently++;
        }
      }

      await this.pull();
      await this.sendHeartbeat();
      await this.prune();
      const t = this.now();
      await this.db.setKv(KV.lastSyncAt, t);
      this.setState({ syncing: false, syncingCount: 0, online: true, lastSyncAt: t, lastError: null, consecutiveFailures: 0 });
      return { ok: true, pushed, failedPermanently };
    } catch (err) {
      const e = toSyncError(err);
      this.setState({ syncing: false, syncingCount: 0, lastError: e.message, consecutiveFailures: this.state.consecutiveFailures + 1 });
      return { ok: false, pushed, failedPermanently, error: e.message };
    }
  }

  private async send(op: OutboxOp): Promise<void> {
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
      case "qr_photo":
        return this.sendPhoto(op.payload as PhotoOpPayload);
      default:
        throw new SyncError(`This app version can't send "${op.type}" entries. Update the app.`, true);
    }
  }

  private async sendPhoto(p: PhotoOpPayload): Promise<void> {
    const photo = await this.db.photos.get(p.photo_id);
    if (!photo) throw new SyncError("The photo is no longer on this tablet", true);
    if (photo.uploadedPath) return;
    const businessId = p.business_id || (await this.db.getKv<CachedSnapshot>(KV.snapshot))?.snapshot.business.id || "";
    await this.transport.uploadPaymentPhoto({ transactionId: p.transaction_id, businessId, bytes: photo.bytes, mime: photo.mime });
    await this.db.photos.update(photo.id, { uploadedPath: `${businessId}/${p.transaction_id}.jpg` });
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
    await this.db.setKv<CachedSnapshot>(KV.snapshot, { snapshot, pulledAt, pullSeq, menuVersion: menuVersion(snapshot) });
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

  /** "Retry now" on one entry (or all with no argument): clears backoff and failed state, then syncs. */
  async retryNow(seq?: number): Promise<SyncResult> {
    const reset = { status: "pending" as const, nextRetryAt: undefined };
    if (seq === undefined) {
      await this.db.outbox.where("status").anyOf(["pending", "failed"]).modify(reset);
    } else {
      await this.db.outbox.update(seq, reset);
    }
    return this.syncOnce();
  }

  /** Background loop. See scheduleNext() for the timing. */
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

  /** When to look again: every 30s while anything waits (sooner when a backoff ends), else every 60s. */
  async nextDelay(): Promise<number> {
    const pending = await this.db.outbox.where("status").equals("pending").toArray();
    if (pending.length === 0) return IDLE_INTERVAL_MS;
    const now = this.now();
    const head = pending.reduce((a, b) => ((a.seq ?? 0) < (b.seq ?? 0) ? a : b));
    const due = Math.max(1_000, (head.nextRetryAt ?? now) - now);
    return Math.min(PENDING_INTERVAL_MS, due);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.syncOnce();
      this.schedule(await this.nextDelay().catch(() => PENDING_INTERVAL_MS));
    }, delay);
  }

  /** The connection came back: don't wait out old backoffs, send now. */
  private onOnline = async () => {
    this.setState({ consecutiveFailures: 0 });
    await this.db.outbox.where("status").equals("pending").modify({ nextRetryAt: undefined }).catch(() => {});
    this.schedule(0);
  };
  private onOffline = () => this.setState({ online: false });
  private onVisible = () => {
    if (document.visibilityState === "visible") this.schedule(0);
  };
}

/** Changes whenever the sellable menu or prices change. */
export function menuVersion(snapshot: Snapshot): string {
  const menu = JSON.stringify([
    snapshot.event?.id ?? null,
    (snapshot.products ?? []).map((p) => [p.event_product_id, p.name, p.price_centavos, p.is_available, p.category]),
    (snapshot.bundles ?? []).map((b) => [b.event_bundle_id, b.name, b.price_centavos, b.is_available]),
  ]);
  let h = 5381;
  for (let i = 0; i < menu.length; i++) h = ((h << 5) + h + menu.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function toSyncError(err: unknown): SyncError {
  if (err instanceof SyncError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SyncError(message, false);
}
