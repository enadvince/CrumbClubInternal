"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useOwner } from "../OwnerContext";
import { Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { errorMessage } from "@/lib/errors";

type Staff = { id: string; name: string; role: "owner" | "staff"; active: boolean; pin_hash: string | null; user_id: string | null };

export default function StaffPage() {
  const { businessId } = useOwner();
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pinFor, setPinFor] = useState<Staff | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await getSupabase()
      .from("staff").select("id, name, role, active, pin_hash, user_id").order("active", { ascending: false }).order("name");
    if (error) setError(errorMessage(error));
    else setStaff(data as Staff[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggleActive(s: Staff) {
    const { error } = await getSupabase().from("staff").update({ active: !s.active }).eq("id", s.id);
    if (error) setError(errorMessage(error));
    load();
  }

  return (
    <>
      <PageHeader
        title="Staff"
        subtitle="Everyone who rings up sales on the tablet. Each person needs a unique 4-digit PIN."
        actions={<button className="btn-primary" onClick={() => setAdding(true)}>+ Add staff</button>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      <Notice className="mb-4">
        PIN changes reach the tablet the next time it syncs (it needs to be online once).
      </Notice>
      {!staff ? <Spinner /> : (
        <div className="card divide-y divide-crust-dark">
          {staff.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-40 flex-1">
                <p className="font-semibold">{s.name} {!s.active && <span className="badge bg-crust text-ink-soft">Inactive</span>}</p>
                <p className="text-sm text-ink-soft">
                  {s.role === "owner" ? "Owner" : "Staff"} · {s.pin_hash ? "PIN set" : "⚠ No PIN yet"}
                </p>
              </div>
              <button className="btn-secondary" onClick={() => setPinFor(s)}>{s.pin_hash ? "Change PIN" : "Set PIN"}</button>
              {!s.user_id && (
                <button className="btn-ghost" onClick={() => toggleActive(s)}>{s.active ? "Deactivate" : "Reactivate"}</button>
              )}
            </div>
          ))}
        </div>
      )}
      <AddStaffModal open={adding} onClose={() => setAdding(false)} businessId={businessId} onSaved={(s) => { setAdding(false); load(); setPinFor(s); }} />
      <PinModal staff={pinFor} onClose={() => setPinFor(null)} onSaved={() => { setPinFor(null); load(); }} />
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
      .from("staff").insert({ business_id: businessId, name, role }).select("id, name, role, active, pin_hash, user_id").single();
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

function PinModal({ staff, onClose, onSaved }: { staff: Staff | null; onClose: () => void; onSaved: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPin(""); setError(null); }, [staff]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { error } = await getSupabase().rpc("set_staff_pin", { p_staff_id: staff!.id, p_pin: pin });
    if (error) return setError(errorMessage(error));
    onSaved();
  }

  return (
    <Modal open={!!staff} onClose={onClose} title={`PIN for ${staff?.name ?? ""}`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="New 4-digit PIN" htmlFor="new-pin">
          <input id="new-pin" autoFocus required inputMode="numeric" pattern="\d{4}" maxLength={4}
            className="input text-center text-2xl tracking-[0.6em]" value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <button className="btn-primary w-full" disabled={pin.length !== 4}>Save PIN</button>
      </form>
    </Modal>
  );
}
