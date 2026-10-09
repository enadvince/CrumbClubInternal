"use client";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDb, KV } from "@/lib/offline/db";
import { lockRemainingMs, recordPinAttempt, type PinLockState } from "@/lib/offline/pinLock";
import { auditLocally } from "@/lib/offline/actions";
import type { SnapshotStaff } from "@/lib/pos/types";
import { PinPad } from "./PinPad";

/**
 * Owner PIN entry for anything that needs an owner's approval (voids, refunds, cash out,
 * variance, reports). Checked offline against cached hashes. Five wrong PINs lock owner
 * PIN entry on this tablet for 5 minutes.
 */
export function OwnerPinGate({
  staff, title, subtitle, onApproved, onCancel, eventId = "",
}: {
  staff: SnapshotStaff[];
  title: string;
  subtitle?: React.ReactNode;
  onApproved: (owner: SnapshotStaff, pin: string) => void;
  onCancel?: () => void;
  eventId?: string;
}) {
  const db = getDb();
  const lock = useLiveQuery(() => db.getKv<PinLockState>(KV.pinLock), []);
  const [now, setNow] = useState(() => Date.now());
  const remaining = lockRemainingMs(lock, now);
  useEffect(() => {
    if (remaining <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [remaining]);

  return (
    <PinPad
      staff={staff}
      requireOwner
      title={title}
      subtitle={subtitle}
      lockedMs={remaining}
      onCancel={onCancel}
      onFail={async () => {
        const next = await recordPinAttempt(db, false);
        setNow(Date.now());
        if (next.lockedUntil) await auditLocally(db, { action: "pin_lockout", reason: "5 wrong owner PINs" }, eventId);
      }}
      onUnlock={async (owner, pin) => {
        await recordPinAttempt(db, true);
        onApproved(owner, pin);
      }}
    />
  );
}
