"use client";
import { useEffect, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { Field, Notice } from "@/components/ui";
import { MoneyInput } from "@/components/MoneyInput";
import { errorMessage } from "@/lib/errors";
import { useOwner } from "../OwnerContext";

/** Cash variance threshold for closing shifts, and how long backups are kept. */
export function Settings() {
  const { businessId } = useOwner();
  const [threshold, setThreshold] = useState<number | null>(null);
  const [retention, setRetention] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  useEffect(() => {
    getSupabase().from("businesses").select("variance_threshold_centavos, backup_retention_days").eq("id", businessId).single()
      .then(({ data }) => {
        const b = data as { variance_threshold_centavos: number; backup_retention_days: number } | null;
        if (b) { setThreshold(b.variance_threshold_centavos); setRetention(String(b.backup_retention_days)); }
      });
  }, [businessId]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const days = Number(retention);
    if (threshold == null || !Number.isInteger(days) || days < 7 || days > 3650) {
      return setMessage({ tone: "danger", text: "Enter a threshold, and a retention between 7 and 3650 days." });
    }
    const { error } = await getSupabase().from("businesses")
      .update({ variance_threshold_centavos: threshold, backup_retention_days: days }).eq("id", businessId);
    setMessage(error ? { tone: "danger", text: errorMessage(error) } : { tone: "ok", text: "Saved. Tablets pick up the threshold on their next sync." });
  }

  return (
    <form onSubmit={save} className="space-y-3">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cash variance needing an owner PIN" htmlFor="s-threshold" hint="Closing a shift over or short by more than this needs an owner PIN and a note.">
          <MoneyInput id="s-threshold" value={threshold} onChange={setThreshold} />
        </Field>
        <Field label="Keep backups for (days)" htmlFor="s-retention" hint="Older nightly backups are deleted automatically.">
          <input id="s-retention" className="input" inputMode="numeric" value={retention} onChange={(e) => setRetention(e.target.value.replace(/\D/g, ""))} />
        </Field>
      </div>
      <button className="btn-primary">Save settings</button>
    </form>
  );
}
