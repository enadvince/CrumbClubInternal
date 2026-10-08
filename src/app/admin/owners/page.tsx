"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useOwner } from "../OwnerContext";
import { Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/time";

type Owner = {
  user_id: string; email: string; name: string | null; co_owner: boolean; joined_at: string;
  pin_locked_until: string | null;
};

/** "locked" until the main owner resets the PIN, "wait" for a 15-minute lock, or null. */
function lockState(o: Owner): "locked" | "wait" | null {
  if (!o.pin_locked_until) return null;
  if (o.pin_locked_until === "infinity") return "locked";
  return new Date(o.pin_locked_until) > new Date() ? "wait" : null;
}

const pinInput = "input text-center text-2xl tracking-[0.6em]";
const digits = (v: string) => v.replace(/\D/g, "").slice(0, 4);

/** The main owner and co-owners. Only the main owner can add or remove co-owners or reset their PINs. */
export default function OwnersPage() {
  const { businessId, userId } = useOwner();
  const [owners, setOwners] = useState<Owner[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<Owner | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await getSupabase().rpc("business_owners", { p_business: businessId });
    if (error) setError(errorMessage(error));
    setOwners((data as Owner[]) ?? []);
  }, [businessId]);
  useEffect(() => { load(); }, [load]);

  const isMain = !!owners?.some((o) => o.user_id === userId && !o.co_owner);

  async function remove(o: Owner) {
    if (!confirm(`Remove ${o.name ?? o.email} as a co-owner? They will no longer be able to sign in.`)) return;
    const { error } = await getSupabase().rpc("remove_co_owner", { p_user: o.user_id });
    if (error) setError(errorMessage(error));
    load();
  }

  return (
    <>
      <PageHeader
        title="Owners"
        subtitle="People who can open the owner pages. Co-owners sign in with their email and 4-digit PIN."
        actions={isMain && <button className="btn-primary" onClick={() => setAdding(true)}>+ Add co-owner</button>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {owners && !isMain && (
        <Notice className="mb-4">Only the main owner can add or remove co-owners and reset their PINs.</Notice>
      )}

      {!owners ? <Spinner /> : (
        <div className="card divide-y divide-crust-dark">
          {owners.map((o) => {
            const lock = lockState(o);
            return (
              <div key={o.user_id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-40 flex-1">
                  <p className="font-semibold">
                    {o.name ?? o.email}{" "}
                    <span className="badge bg-crust text-ink-soft">{o.co_owner ? "Co-owner" : "Main owner"}</span>{" "}
                    {o.user_id === userId && <span className="badge bg-crust text-ink-soft">You</span>}{" "}
                    {lock === "locked" && <span className="badge bg-danger-light text-danger">🔒 Locked until PIN reset</span>}
                    {lock === "wait" && <span className="badge bg-warn-light text-warn">🔒 Locked for 15 min</span>}
                  </p>
                  <p className="text-sm text-ink-soft">{o.email} · Since {formatDateTime(o.joined_at)}</p>
                </div>
                {isMain && o.co_owner && (
                  <>
                    <button className="btn-secondary" onClick={() => setResetFor(o)}>{lock ? "Reset PIN & unlock" : "Reset PIN"}</button>
                    <button className="btn-ghost" onClick={() => remove(o)}>Remove</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddCoOwnerModal open={adding} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />
      <ResetPinModal owner={resetFor} onClose={() => setResetFor(null)} onSaved={() => { setResetFor(null); load(); }} />
    </>
  );
}

function AddCoOwnerModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setName(""); setEmail(""); setPin(""); setError(null); } }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch("/api/owners/co-owners", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, pin }),
    }).catch(() => null);
    setSaving(false);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) return setError(body?.error ?? "Could not add the co-owner. Check your connection.");
    onSaved();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a co-owner">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Name (shown on sales they ring up)" htmlFor="co-name">
          <input id="co-name" autoFocus required className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" htmlFor="co-email" hint="They sign in with this email.">
          <input id="co-email" type="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Their 4-digit PIN" htmlFor="co-pin" hint="Tell them their PIN. It also works on the POS tablet. They can change it later on the Staff page.">
          <input id="co-pin" type="password" required inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4}
            className={pinInput} value={pin} onChange={(e) => setPin(digits(e.target.value))} />
        </Field>
        <Notice tone="warn">Co-owners can see all sales, costs and staff. They can&apos;t add or remove owners.</Notice>
        <button className="btn-primary w-full" disabled={saving || pin.length !== 4}>{saving ? "Adding…" : "Add co-owner"}</button>
      </form>
    </Modal>
  );
}

function ResetPinModal({ owner, onClose, onSaved }: { owner: Owner | null; onClose: () => void; onSaved: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setPin(""); setError(null); }, [owner]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!owner) return;
    setSaving(true);
    const { error } = await getSupabase().rpc("reset_co_owner_pin", { p_user: owner.user_id, p_pin: pin });
    setSaving(false);
    if (error) return setError(errorMessage(error));
    onSaved();
  }

  return (
    <Modal open={!!owner} onClose={onClose} title={`New PIN for ${owner?.name ?? owner?.email ?? ""}`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <p className="text-sm text-ink-soft">This replaces their PIN and unlocks their sign-in.</p>
        <Field label="New 4-digit PIN" htmlFor="reset-pin">
          <input id="reset-pin" autoFocus required type="password" inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4}
            className={pinInput} value={pin} onChange={(e) => setPin(digits(e.target.value))} />
        </Field>
        <button className="btn-primary w-full" disabled={saving || pin.length !== 4}>{saving ? "Saving…" : "Set PIN"}</button>
      </form>
    </Modal>
  );
}
