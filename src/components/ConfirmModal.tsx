"use client";
import { useState, type ReactNode } from "react";
import { Modal } from "./Modal";

/**
 * Asks before a destructive action (void, refund, clear cart, cash out, close shift,
 * reset device...). With `blockedReason`, explains why the action can't happen yet
 * instead of offering it.
 */
export function ConfirmModal({
  open, title, children, confirmLabel, onConfirm, onClose, tone = "danger", blockedReason,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  tone?: "danger" | "primary";
  blockedReason?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={title}>
      <div className="space-y-4">
        {children}
        {blockedReason && (
          <p role="alert" className="rounded-xl bg-danger-light p-3 font-semibold text-danger">✕ {blockedReason}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>{blockedReason ? "OK" : "Cancel"}</button>
          {!blockedReason && (
            <button
              className={tone === "danger" ? "btn-danger" : "btn-primary"}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try { await onConfirm(); } finally { setBusy(false); }
              }}
            >
              {busy ? "Working..." : confirmLabel}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
