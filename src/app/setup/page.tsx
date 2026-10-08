"use client";
import { useState, type FormEvent } from "react";
import { SecretInput } from "@/components/SecretInput";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { Field, Logo, Notice } from "@/components/ui";
import { errorMessage } from "@/lib/errors";

export default function SetupPage() {
  const router = useRouter();
  const [name, setName] = useState("Crumb Club");
  const [ownerName, setOwnerName] = useState("");
  const [pin, setPin] = useState("");
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await getSupabase().rpc("create_business", {
      p_name: name, p_owner_name: ownerName, p_owner_pin: pin, p_load_sample: sample,
    });
    setBusy(false);
    if (error) return setError(errorMessage(error));
    router.replace("/admin/dashboard");
    router.refresh();
  }

  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <Logo className="text-3xl text-caramel" />
      <form onSubmit={submit} className="card w-full max-w-md space-y-4 p-6">
        <h1 className="text-xl font-bold">Set up your business</h1>
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Business name" htmlFor="biz">
          <input id="biz" required className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Your name (shown on sales you ring up)" htmlFor="owner">
          <input id="owner" required className="input" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
        </Field>
        <Field label="Your 4-digit PIN" htmlFor="pin" hint="Unlocks the owner menu on the POS tablet and lets you ring up sales.">
          <SecretInput id="pin" required inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4} className="tracking-[0.5em]" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
        </Field>
        <label className="flex min-h-12 items-center gap-3">
          <input type="checkbox" className="h-5 w-5 accent-caramel" checked={sample} onChange={(e) => setSample(e.target.checked)} />
          Load a sample menu (pastries, bundles, staff PINs 1111/2222, a draft event)
        </label>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Setting up…" : "Create business"}</button>
      </form>
    </main>
  );
}
