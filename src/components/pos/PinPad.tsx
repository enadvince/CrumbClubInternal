"use client";
import { useState } from "react";
import { findStaffByPin } from "@/lib/pin";
import type { SnapshotStaff } from "@/lib/pos/types";
import { tapFeedback } from "./feedback";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

/** 4-digit PIN entry, verified on-device against cached bcrypt hashes (works offline). */
export function PinPad({
  staff, title, subtitle, onUnlock, onCancel, requireOwner = false,
}: {
  staff: SnapshotStaff[];
  title: string;
  subtitle?: React.ReactNode;
  onUnlock: (s: SnapshotStaff) => void;
  onCancel?: () => void;
  requireOwner?: boolean;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function press(key: (typeof KEYS)[number]) {
    tapFeedback();
    if (checking) return;
    setError(null);
    if (key === "clear") return setPin("");
    if (key === "back") return setPin((p) => p.slice(0, -1));
    const next = (pin + key).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      setChecking(true);
      const candidates = requireOwner ? staff.filter((s) => s.role === "owner") : staff;
      const match = await findStaffByPin(next, candidates);
      setChecking(false);
      if (match) {
        setPin("");
        onUnlock(match);
      } else {
        setPin("");
        setError(requireOwner ? "That isn't an owner PIN." : "PIN not recognised. Try again.");
      }
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-5">
      <div className="text-center">
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <div className="mt-1 text-ink-soft">{subtitle}</div>}
      </div>
      <div className="flex gap-4" aria-label={`${pin.length} of 4 digits entered`} role="status">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`h-5 w-5 rounded-full border-2 border-ink ${i < pin.length ? "bg-ink" : ""}`} />
        ))}
      </div>
      <p role="alert" className="min-h-6 font-semibold text-danger">{error ? `✕ ${error}` : checking ? "Checking…" : ""}</p>
      {staff.length === 0 && <p className="text-center text-warn">⚠ No staff PINs downloaded yet. Connect to the internet once.</p>}
      <div className="grid w-full grid-cols-3 gap-3">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            className={`btn h-20 text-2xl ${k === "clear" || k === "back" ? "bg-crust text-ink" : "bg-paper border-2 border-crust-dark text-ink"}`}
            aria-label={k === "back" ? "Delete last digit" : k === "clear" ? "Clear" : k}
          >
            {k === "back" ? "⌫" : k === "clear" ? "Clear" : k}
          </button>
        ))}
      </div>
      {onCancel && <button className="btn-ghost" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
