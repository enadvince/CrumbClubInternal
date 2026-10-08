/**
 * Retry schedule for a queue entry after its n-th failed attempt (n >= 1):
 * 2s, 4s, 8s, 16s, 32s, then every 60s. Jitter of +/-20% spreads retries from
 * several tablets, and no delay ever exceeds 5 minutes.
 */
export const BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 16_000, 32_000] as const;
export const BACKOFF_STEADY_MS = 60_000;
export const BACKOFF_CAP_MS = 5 * 60_000;
export const BACKOFF_JITTER = 0.2;

export function baseBackoff(attempts: number): number {
  if (attempts <= 0) return 0;
  return BACKOFF_STEPS_MS[attempts - 1] ?? BACKOFF_STEADY_MS;
}

/** `random` returns [0, 1); injectable for tests. */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const base = baseBackoff(attempts);
  const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER;
  return Math.min(BACKOFF_CAP_MS, Math.max(0, Math.round(base * jitter)));
}
