"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useOwner } from "../OwnerContext";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { MoneyInput } from "@/components/MoneyInput";
import { parsePercent } from "@/lib/money";
import { errorMessage } from "@/lib/errors";
import { describeDiscountOption } from "@/components/pos/DiscountModal";

type DiscountOptionRow = {
  id: string; name: string; type: "percent" | "fixed"; value: number; active: boolean; sort_order: number;
};

/** Preset discounts staff can apply with one tap on the POS. */
export default function DiscountsPage() {
  const [options, setOptions] = useState<DiscountOptionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DiscountOptionRow | "new" | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await getSupabase()
      .from("discount_options").select("id, name, type, value, active, sort_order")
      .order("active", { ascending: false }).order("sort_order").order("name");
    if (error) setError(errorMessage(error));
    else setOptions(data as DiscountOptionRow[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggleActive(o: DiscountOptionRow) {
    const { error } = await getSupabase().from("discount_options").update({ active: !o.active }).eq("id", o.id);
    if (error) setError(errorMessage(error));
    load();
  }

  return (
    <>
      <PageHeader
        title="Discounts"
        subtitle="Discount options staff can pick on the POS. Each needs a name and an amount (% or ₱)."
        actions={<button className="btn-primary" onClick={() => setEditing("new")}>+ Add discount</button>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      <Notice className="mb-4">Changes reach the tablet the next time it syncs. Staff can still enter a custom discount.</Notice>
      {!options ? <Spinner /> : options.length === 0 ? (
        <EmptyState>No discount options yet. Add one, e.g. “Senior citizen – 20%”.</EmptyState>
      ) : (
        <div className="card divide-y divide-crust-dark">
          {options.map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-40 flex-1">
                <p className="font-semibold">{o.name} {!o.active && <span className="badge bg-crust text-ink-soft">Hidden</span>}</p>
                <p className="text-sm text-ink-soft">{describeDiscountOption(o)}</p>
              </div>
              <button className="btn-secondary" onClick={() => setEditing(o)}>Edit</button>
              <button className="btn-ghost" onClick={() => toggleActive(o)}>{o.active ? "Hide" : "Show"}</button>
            </div>
          ))}
        </div>
      )}
      <DiscountForm option={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
    </>
  );
}

function DiscountForm({ option, onClose, onSaved }: { option: DiscountOptionRow | "new" | null; onClose: () => void; onSaved: () => void }) {
  const { businessId } = useOwner();
  const isNew = option === "new";
  const [name, setName] = useState("");
  const [type, setType] = useState<"percent" | "fixed">("percent");
  const [percentText, setPercentText] = useState("");
  const [fixed, setFixed] = useState<number | null>(null);
  const [sortOrder, setSortOrder] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setError(null);
    if (option && option !== "new") {
      setName(option.name); setType(option.type); setSortOrder(option.sort_order);
      setPercentText(option.type === "percent" ? String(option.value / 100) : "");
      setFixed(option.type === "fixed" ? option.value : null);
    } else {
      setName(""); setType("percent"); setPercentText(""); setFixed(null); setSortOrder(0);
    }
  }, [option]);

  const value = type === "percent" ? parsePercent(percentText) : fixed;
  const valid = name.trim().length > 0 && value != null && value > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return setError(type === "percent" ? "Enter a percent between 0.01 and 100." : "Enter an amount above ₱0.");
    setSaving(true);
    const row = { name: name.trim(), type, value, sort_order: sortOrder };
    const supabase = getSupabase();
    const { error } = isNew
      ? await supabase.from("discount_options").insert({ ...row, business_id: businessId })
      : await supabase.from("discount_options").update(row).eq("id", (option as DiscountOptionRow).id);
    setSaving(false);
    if (error) return setError(errorMessage(error));
    onSaved();
  }

  async function remove() {
    if (!option || option === "new" || !confirm(`Delete “${option.name}”? Past sales keep their discount.`)) return;
    const { error } = await getSupabase().from("discount_options").delete().eq("id", option.id);
    if (error) return setError(errorMessage(error));
    onSaved();
  }

  return (
    <Modal open={!!option} onClose={onClose} title={isNew ? "Add discount" : "Edit discount"}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Name" htmlFor="d-name" hint="Shown on the POS button and saved as the discount reason.">
          <input id="d-name" required className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Senior citizen" />
        </Field>
        <fieldset>
          <legend className="label">Type</legend>
          <div className="flex gap-2">
            {([["percent", "% off"], ["fixed", "₱ off"]] as const).map(([t, label]) => (
              <label key={t} className={`btn-secondary flex-1 ${type === t ? "border-caramel bg-crust" : ""}`}>
                <input type="radio" name="d-type" value={t} checked={type === t} onChange={() => setType(t)} className="sr-only" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {type === "percent" ? (
          <Field label="Percent" htmlFor="d-percent">
            <input id="d-percent" className="input" inputMode="decimal" value={percentText} onChange={(e) => setPercentText(e.target.value)} placeholder="20" />
          </Field>
        ) : (
          <Field label="Amount" htmlFor="d-fixed">
            <MoneyInput id="d-fixed" value={fixed} onChange={setFixed} />
          </Field>
        )}
        <Field label="Order on the POS" htmlFor="d-sort" hint="Lower numbers show first.">
          <input id="d-sort" type="number" className="input w-28" value={sortOrder} onChange={(e) => setSortOrder(Math.trunc(Number(e.target.value) || 0))} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary flex-1" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          {!isNew && <button type="button" className="btn-ghost text-danger" onClick={remove}>Delete</button>}
        </div>
      </form>
    </Modal>
  );
}
