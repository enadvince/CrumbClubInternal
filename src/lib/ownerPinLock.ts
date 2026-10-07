/**
 * Lockout for owner PIN attempts made from the POS tablet to open owner view.
 * A 4-digit PIN is guessable, so after a few misses the tablet is locked out
 * for a while. State lives in the device user's app_metadata (server-only).
 */
export const MAX_OWNER_PIN_FAILURES = 5;
export const OWNER_PIN_LOCK_MS = 15 * 60 * 1000;

export type OwnerPinLock = { owner_pin_failures?: number; owner_pin_locked_until?: number | null };

/** Milliseconds left on the lockout, or 0 when the tablet may try again. */
export function lockRemaining(lock: OwnerPinLock, now: number): number {
  return Math.max(0, (lock.owner_pin_locked_until ?? 0) - now);
}

/** Next lock state after an attempt. A success resets the counter. */
export function nextLock(lock: OwnerPinLock, ok: boolean, now: number): Required<OwnerPinLock> {
  if (ok) return { owner_pin_failures: 0, owner_pin_locked_until: null };
  // A lock that has run out starts a fresh count.
  const previous = lock.owner_pin_locked_until && lockRemaining(lock, now) === 0 ? 0 : lock.owner_pin_failures ?? 0;
  const failures = previous + 1;
  return failures >= MAX_OWNER_PIN_FAILURES
    ? { owner_pin_failures: failures, owner_pin_locked_until: now + OWNER_PIN_LOCK_MS }
    : { owner_pin_failures: failures, owner_pin_locked_until: null };
}
