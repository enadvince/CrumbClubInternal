import { describe, expect, it } from "vitest";
import { lockRemaining, MAX_OWNER_PIN_FAILURES, nextLock, OWNER_PIN_LOCK_MS } from "./ownerPinLock";

describe("owner PIN lockout", () => {
  it("counts failures and locks after the limit", () => {
    let lock = {};
    for (let i = 1; i < MAX_OWNER_PIN_FAILURES; i++) {
      lock = nextLock(lock, false, 1000);
      expect(lockRemaining(lock, 1000)).toBe(0);
    }
    lock = nextLock(lock, false, 1000);
    expect(lockRemaining(lock, 1000)).toBe(OWNER_PIN_LOCK_MS);
    expect(lockRemaining(lock, 1000 + OWNER_PIN_LOCK_MS)).toBe(0);
  });

  it("resets on success", () => {
    const lock = nextLock({ owner_pin_failures: 3 }, true, 0);
    expect(lock).toEqual({ owner_pin_failures: 0, owner_pin_locked_until: null });
  });

  it("starts a fresh count once a lock has expired", () => {
    const expired = { owner_pin_failures: MAX_OWNER_PIN_FAILURES, owner_pin_locked_until: 500 };
    expect(nextLock(expired, false, 1000)).toEqual({ owner_pin_failures: 1, owner_pin_locked_until: null });
  });
});
