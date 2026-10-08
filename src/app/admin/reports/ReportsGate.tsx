"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { Field, Notice } from "@/components/ui";
import { SecretInput } from "@/components/SecretInput";
import { errorMessage } from "@/lib/errors";

const KEY = "crumbclub-reports-unlocked-until";
const UNLOCK_MS = 15 * 60 * 1000;

function unlockedUntil(): number {
  try { return Number(sessionStorage.getItem(KEY) ?? 0); } catch { return 0; }
}

/** Reports and exports need an owner PIN (checked on the server and logged), valid for 15 minutes in this tab. */
export function ReportsGate({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOpen(unlockedUntil() > Date.now()), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await getSupabase().rpc("check_owner_pin", { p_pin: pin, p_action: "reports_access" });
    setBusy(false);
    setPin("");
    if (error) return setError(errorMessage(error));
    try { sessionStorage.setItem(KEY, String(Date.now() + UNLOCK_MS)); } catch { /* private mode: unlock for this page view */ }
    setOpen(true);
  }

  if (open === null) return null;
  if (open) return <>{children}</>;
  return (
    <form onSubmit={submit} className="card mx-auto max-w-sm space-y-4 p-6">
      <h2 className="text-lg font-bold">Owner PIN</h2>
      <p className="text-sm text-ink-soft">Reports and exports need an owner PIN. Each unlock is recorded in the audit log.</p>
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label="Owner PIN" htmlFor="reports-pin">
        <SecretInput id="reports-pin" autoFocus inputMode="numeric" autoComplete="off" maxLength={4} className="text-center text-xl tracking-[0.5em]"
          value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
      </Field>
      <button className="btn-primary w-full" disabled={busy || pin.length !== 4}>{busy ? "Checking..." : "Open reports"}</button>
    </form>
  );
}
