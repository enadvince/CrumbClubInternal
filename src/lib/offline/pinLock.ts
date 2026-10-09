import { KV, type PosDatabase } from "./db";

/**
 * Owner PIN lockout on this tablet: after 5 wrong owner PINs, owner PIN entry is
 * locked for 5 minutes. Kept in IndexedDB so a reload doesn't reset it, and checked
 * entirely offline.
 */
export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MS = 5 * 60 * 1000;

export type PinLockState = { failures: number; lockedUntil: number | null };
export const UNLOCKED: PinLockState = { failures: 0, lockedUntil: null };

export function lockRemainingMs(state: PinLockState | undefined, now: number): number {
  return Math.max(0, (state?.lockedUntil ?? 0) - now);
}

/** Next state after an attempt. A success clears it; the 5th failure in a row locks. */
export function afterAttempt(state: PinLockState | undefined, ok: boolean, now: number): PinLockState {
  if (ok) return UNLOCKED;
  const current = state ?? UNLOCKED;
  // A lock that has run out starts a fresh count.
  const previous = current.lockedUntil && current.lockedUntil <= now ? 0 : current.failures;
  const failures = previous + 1;
  return failures >= MAX_PIN_FAILURES ? { failures, lockedUntil: now + PIN_LOCK_MS } : { failures, lockedUntil: null };
}

export async function recordPinAttempt(db: PosDatabase, ok: boolean, now = Date.now()): Promise<PinLockState> {
  return db.transaction("rw", db.kv, async () => {
    const next = afterAttempt(await db.getKv<PinLockState>(KV.pinLock), ok, now);
    await db.setKv(KV.pinLock, next);
    return next;
  });
}
