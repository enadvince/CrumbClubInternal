import "fake-indexeddb/auto";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { PosDatabase } from "./db";
import { afterAttempt, lockRemainingMs, MAX_PIN_FAILURES, PIN_LOCK_MS, recordPinAttempt } from "./pinLock";
import { findStaffByPin } from "../pin";

const owners = [{ id: "o1", name: "Owner", role: "owner" as const, pin_hash: bcrypt.hashSync("1234", 4) }];

describe("owner PIN lockout", () => {
  it("verifies PINs against the cached bcrypt hashes, offline", async () => {
    expect((await findStaffByPin("1234", owners))?.id).toBe("o1");
    expect(await findStaffByPin("9999", owners)).toBeNull();
  });

  it("locks for 5 minutes after 5 wrong PINs in a row", () => {
    let s = undefined;
    const t = 1_000_000;
    for (let i = 1; i < MAX_PIN_FAILURES; i++) {
      s = afterAttempt(s, false, t + i);
      expect(lockRemainingMs(s, t + i)).toBe(0);
    }
    s = afterAttempt(s, false, t + 10);
    expect(lockRemainingMs(s, t + 10)).toBe(PIN_LOCK_MS);
    expect(lockRemainingMs(s, t + 10 + PIN_LOCK_MS - 1)).toBe(1);
    expect(lockRemainingMs(s, t + 10 + PIN_LOCK_MS)).toBe(0);
    // After it runs out, counting starts again.
    s = afterAttempt(s, false, t + 10 + PIN_LOCK_MS + 1);
    expect(s).toEqual({ failures: 1, lockedUntil: null });
  });

  it("a correct PIN resets the count", () => {
    let s = afterAttempt(undefined, false, 1);
    s = afterAttempt(s, false, 2);
    expect(afterAttempt(s, true, 3)).toEqual({ failures: 0, lockedUntil: null });
  });

  it("survives a reload (kept in IndexedDB)", async () => {
    const name = `pin-${crypto.randomUUID()}`;
    const db = new PosDatabase(name);
    for (let i = 0; i < 5; i++) await recordPinAttempt(db, false, 100 + i);
    db.close();
    const reopened = new PosDatabase(name);
    const s = await reopened.getKv<{ lockedUntil: number }>("pinLock");
    expect(s?.lockedUntil).toBe(104 + PIN_LOCK_MS);
    reopened.close();
    await PosDatabase.delete(name);
  });
});
