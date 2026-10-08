"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useOwner } from "../OwnerContext";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/time";

type Staff = { id: string; name: string; role: "owner" | "staff"; active: boolean; pin_hash: string | null; user_id: string | null };
type Owner = {
  user_id: string; email: string; name: string | null; co_owner: boolean; joined_at: string;
  pin_locked_until: string | null;
};
type Person = Staff & { kind: "main" | "co" | "owner" | "staff"; login: Owner | null };
type Filter = "all" | "owner" | "staff";

const STAFF_COLUMNS = "id, name, role, active, pin_hash, user_id";
const KIND_LABEL: Record<Person["kind"], string> = {
  main: "Main owner", co: "Co-owner", owner: "Owner (tablet only)", staff: "Staff",
};
const KIND_ORDER: Record<Person["kind"], number> = { main: 0, co: 1, owner: 2, staff: 3 };
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "owner", label: "Owners" },
  { value: "staff", label: "Staff" },
];

/** "locked" until the main owner resets the PIN, "wait" for a 15-minute lock, or null. */
function lockState(o: Owner | null): "locked" | "wait" | null {
  if (!o?.pin_locked_until) return null;
  if (o.pin_locked_until === "infinity") return "locked";
  return new Date(o.pin_locked_until) > new Date() ? "wait" : null;
}

const pinInput = "input text-center text-2xl tracking-[0.6em]";
const digits = (v: string) => v.replace(/\D/g, "").slice(0, 4);

/**
 * Owners (main + co-owners) and staff in one list. Anyone can have their PIN
 * changed. Everyone except the main owner can be deactivated or removed;
 * co-owners only by the main owner. Removing needs your own owner PIN.
 */
export default function PersonnelPage() {
  const { businessId, userId } = useOwner();
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingCoOwner, setAddingCoOwner] = useState(false);
  const [pinFor, setPinFor] = useState<Staff | null>(null);
  const [resetFor, setResetFor] = useState<Owner | null>(null);
  const [removeFor, setRemoveFor] = useState<Person | null>(null);

  const load = useCallback(async () => {
    const supabase = getSupabase();
    const [staffRes, ownersRes] = await Promise.all([
      supabase.from("staff").select(STAFF_COLUMNS).is("removed_at", null),
      supabase.rpc("business_owners", { p_business: businessId }),
    ]);
    const err = staffRes.error ?? ownersRes.error;
    setError(err ? errorMessage(err) : null);
    setOwners((ownersRes.data as Owner[]) ?? []);
    setStaff((staffRes.data as Staff[]) ?? []);
  }, [businessId]);
  useEffect(() => { load(); }, [load]);
  // Old /admin/staff and /admin/owners links redirect here with ?show=.
  useEffect(() => {
    const show = new URLSearchParams(window.location.search).get("show");
    if (show === "owner" || show === "staff") setFilter(show);
  }, []);

  const isMain = owners.some((o) => o.user_id === userId && !o.co_owner);

  const people = useMemo<Person[] | null>(() => {
    if (!staff) return null;
    const byUser = new Map(owners.map((o) => [o.user_id, o]));
    return staff
      .map((s): Person => {
        const login = s.user_id ? byUser.get(s.user_id) ?? null : null;
        const kind = login ? (login.co_owner ? "co" : "main") : s.role === "owner" ? "owner" : "staff";
        return { ...s, kind, login };
      })
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }, [staff, owners]);

  const shown = people?.filter((p) => filter === "all" || (filter === "owner" ? p.role === "owner" : p.role === "staff"));
  const count = (f: Filter) => people?.filter((p) => f === "all" || p.role === f).length ?? 0;

  /** The main owner can't be deactivated or removed; co-owners only by the main owner. */
  const canManage = (p: Person) => p.kind !== "main" && (p.kind !== "co" || isMain);

  async function toggleActive(p: Person) {
    if (p.active && p.kind === "co" && !confirm(`Deactivate ${p.name}? They won't be able to open the owner pages until reactivated.`)) return;
    const { error } = await getSupabase().from("staff").update({ active: !p.active }).eq("id", p.id);
    if (error) setError(errorMessage(error));
    load();
  }

  return (
    <>
      <PageHeader
        title="Personnel"
        subtitle="Owners and staff. Everyone rings up sales on the tablet with their own 4-digit PIN; co-owners also sign in to these pages with their email and PIN."
        actions={<>
          <button className="btn-primary" onClick={() => setAdding(true)}>+ Add staff</button>
          {isMain && <button className="btn-secondary" onClick={() => setAddingCoOwner(true)}>+ Add co-owner</button>}
        </>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      <Notice className="mb-4">
        PIN changes reach the tablet the next time it syncs (it needs to be online once).
        {!isMain && " Only the main owner can add, deactivate or remove co-owners and reset their PINs."}
      </Notice>

      <div className="mb-4 flex gap-2" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}
            className={`btn-secondary ${filter === f.value ? "border-caramel bg-crust" : ""}`}>
            {f.label} <span className="text-ink-soft">({count(f.value)})</span>
          </button>
        ))}
      </div>

      {!shown ? <Spinner /> : shown.length === 0 ? <EmptyState>Nobody here yet.</EmptyState> : (
        <div className="card divide-y divide-crust-dark">
          {shown.map((p) => {
            const lock = lockState(p.login);
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-40 flex-1">
                  <p className="font-semibold">
                    {p.name}{" "}
                    <span className="badge bg-crust text-ink-soft">{KIND_LABEL[p.kind]}</span>{" "}
                    {p.user_id === userId && <span className="badge bg-crust text-ink-soft">You</span>}{" "}
                    {!p.active && <span className="badge bg-crust text-ink-soft">Inactive</span>}{" "}
                    {lock === "locked" && <span className="badge bg-danger-light text-danger">🔒 Locked until PIN reset</span>}
                    {lock === "wait" && <span className="badge bg-warn-light text-warn">🔒 Locked for 15 min</span>}
                  </p>
                  <p className="text-sm text-ink-soft">
                    {p.login && <>{p.login.email} · Since {formatDateTime(p.login.joined_at)} · </>}
                    {p.pin_hash ? "PIN set" : "⚠ No PIN yet"}
                  </p>
                </div>
                <button className="btn-secondary" onClick={() => setPinFor(p)}>{p.pin_hash ? "Change PIN" : "Set PIN"}</button>
                {isMain && p.kind === "co" && p.login && (
                  <button className="btn-secondary" onClick={() => setResetFor(p.login)}>{lock ? "Reset PIN & unlock" : "Reset PIN"}</button>
                )}
                {canManage(p) && (
                  <>
                    <button className="btn-ghost" onClick={() => toggleActive(p)}>{p.active ? "Deactivate" : "Reactivate"}</button>
                    <button className="btn-ghost text-danger" onClick={() => setRemoveFor(p)}>Remove</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddStaffModal open={adding} onClose={() => setAdding(false)} businessId={businessId} onSaved={(s) => { setAdding(false); load(); setPinFor(s); }} />
      <AddCoOwnerModal open={addingCoOwner} onClose={() => setAddingCoOwner(false)} onSaved={() => { setAddingCoOwner(false); load(); }} />
      <PinModal staff={pinFor} onClose={() => setPinFor(null)} onSaved={() => { setPinFor(null); load(); }} />
      <ResetPinModal owner={resetFor} onClose={() => setResetFor(null)} onSaved={() => { setResetFor(null); load(); }} />
      <RemoveModal person={removeFor} onClose={() => setRemoveFor(null)} onSaved={() => { setRemoveFor(null); load(); }} />
    </>
  );
}

function AddStaffModal({ open, onClose, businessId, onSaved }: { open: boolean; onClose: () => void; businessId: string; onSaved: (s: Staff) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<"staff" | "owner">("staff");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { data, error } = await getSupabase()
      .from("staff").insert({ business_id: businessId, name, role }).select(STAFF_COLUMNS).single();
    if (error) return setError(errorMessage(error));
    setName("");
    onSaved(data as Staff);
  }

  return (
    <Modal open={open} onClose={onClose} title="Add staff">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Name" htmlFor="staff-name">
          <input id="staff-name" required className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="label">Role on the tablet</legend>
          <div className="flex gap-2">
            {(["staff", "owner"] as const).map((r) => (
              <label key={r} className={`btn-secondary flex-1 ${role === r ? "border-caramel bg-crust" : ""}`}>
                <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="sr-only" />
                {r === "staff" ? "Staff (POS only)" : "Owner (can open owner menu)"}
              </label>
            ))}
          </div>
        </fieldset>
        <button className="btn-primary w-full">Add and set PIN</button>
      </form>
    </Modal>
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
        <Field label="Their 4-digit PIN" htmlFor="co-pin" hint="Tell them their PIN. It also works on the POS tablet. They can change it later on the Personnel page.">
          <input id="co-pin" type="password" required inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4}
            className={pinInput} value={pin} onChange={(e) => setPin(digits(e.target.value))} />
        </Field>
        <Notice tone="warn">Co-owners can see all sales, costs and staff. They can&apos;t add or remove owners.</Notice>
        <button className="btn-primary w-full" disabled={saving || pin.length !== 4}>{saving ? "Adding…" : "Add co-owner"}</button>
      </form>
    </Modal>
  );
}

function PinModal({ staff, onClose, onSaved }: { staff: Staff | null; onClose: () => void; onSaved: () => void }) {
  const [current, setCurrent] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setCurrent(""); setPin(""); setError(null); }, [staff]);

  // Changing an existing PIN needs the current one; the server checks it before saving.
  const changing = !!staff?.pin_hash;
  const ready = pin.length === 4 && (!changing || current.length === 4);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!staff || !ready) return;
    setSaving(true);
    const { error } = changing
      ? await getSupabase().rpc("change_staff_pin", { p_staff_id: staff.id, p_current_pin: current, p_new_pin: pin })
      : await getSupabase().rpc("set_staff_pin", { p_staff_id: staff.id, p_pin: pin });
    setSaving(false);
    if (error) {
      setCurrent("");
      return setError(errorMessage(error));
    }
    onSaved();
  }

  return (
    <Modal open={!!staff} onClose={onClose} title={`${changing ? "Change PIN" : "PIN"} for ${staff?.name ?? ""}`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        {changing && (
          <Field label="Current PIN" htmlFor="current-pin">
            <input id="current-pin" autoFocus required type="password" inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4}
              className={pinInput} value={current} onChange={(e) => setCurrent(digits(e.target.value))} />
          </Field>
        )}
        <Field label="New 4-digit PIN" htmlFor="new-pin">
          <input id="new-pin" autoFocus={!changing} required type="password" inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4}
            className={pinInput} value={pin} onChange={(e) => setPin(digits(e.target.value))} />
        </Field>
        <button className="btn-primary w-full" disabled={!ready || saving}>{saving ? "Saving…" : changing ? "Change PIN" : "Save PIN"}</button>
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
        <p className="text-sm text-ink-soft">This replaces their PIN without the current one and unlocks their sign-in.</p>
        <Field label="New 4-digit PIN" htmlFor="reset-pin">
          <input id="reset-pin" autoFocus required type="password" inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4}
            className={pinInput} value={pin} onChange={(e) => setPin(digits(e.target.value))} />
        </Field>
        <button className="btn-primary w-full" disabled={saving || pin.length !== 4}>{saving ? "Saving…" : "Set PIN"}</button>
      </form>
    </Modal>
  );
}

/** Removing someone needs the signed-in owner's own PIN; the server checks it. */
function RemoveModal({ person, onClose, onSaved }: { person: Person | null; onClose: () => void; onSaved: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setPin(""); setError(null); }, [person]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!person) return;
    setSaving(true);
    const { error } = await getSupabase().rpc("remove_personnel", { p_staff_id: person.id, p_owner_pin: pin });
    setSaving(false);
    if (error) {
      setPin("");
      return setError(errorMessage(error));
    }
    onSaved();
  }

  return (
    <Modal open={!!person} onClose={onClose} title={`Remove ${person?.name ?? ""}?`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Notice tone="warn">
          {person?.kind === "co"
            ? "They will no longer be able to sign in or use their PIN. "
            : "Their PIN will stop working on the tablet. "}
          Their name stays on past sales. This can&apos;t be undone.
        </Notice>
        <Field label="Your owner PIN" htmlFor="owner-pin">
          <input id="owner-pin" autoFocus required type="password" inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4}
            className={pinInput} value={pin} onChange={(e) => setPin(digits(e.target.value))} />
        </Field>
        <button className="btn-primary w-full" disabled={saving || pin.length !== 4}>{saving ? "Removing…" : "Remove"}</button>
      </form>
    </Modal>
  );
}
