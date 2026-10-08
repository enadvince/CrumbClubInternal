"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { Field, Logo, Notice, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { getDb, KV, type DeviceInfo } from "@/lib/offline/db";

type State = "checking" | "need-owner" | "ready" | "pairing";

export default function PairPage() {
  const router = useRouter();
  const [state, setState] = useState<State>("checking");
  const [label, setLabel] = useState("Counter tablet");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = getSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return setState("need-owner");
      const { data } = await supabase.from("memberships").select("role").eq("user_id", user.id).maybeSingle();
      if (data?.role === "device") return router.replace("/pos");
      setState(data?.role === "owner" ? "ready" : "need-owner");
    })().catch((e) => { setError(errorMessage(e)); setState("need-owner"); });
  }, [router]);

  async function pair() {
    setState("pairing");
    setError(null);
    try {
      const res = await fetch("/api/device/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Pairing failed");
      const supabase = getSupabase();
      // Sign the owner out on this tablet only (not their other devices).
      await supabase.auth.signOut({ scope: "local" });
      const { error } = await supabase.auth.signInWithPassword({ email: body.email, password: body.password });
      if (error) throw error;
      // Claim this tablet's code (T1, T2...) for order numbers while we're online.
      const { data: claimed, error: claimError } = await supabase.rpc("claim_device_code", { p_label: label });
      if (claimError) throw claimError;
      const device = claimed as { device_id: string; device_code: string; label: string | null };
      const { data: { user } } = await supabase.auth.getUser();
      await getDb().setKv<DeviceInfo>(KV.device, {
        userId: user?.id ?? "", deviceId: device.device_id, deviceCode: device.device_code, label: device.label ?? undefined,
      });
      router.replace("/pos");
    } catch (e) {
      setError(errorMessage(e));
      setState("ready");
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <Logo className="text-3xl text-caramel" />
      <div className="card w-full max-w-md space-y-4 p-6">
        <h1 className="text-xl font-bold">Set up this tablet as the POS</h1>
        {error && <Notice tone="danger">{error}</Notice>}
        {state === "checking" && <Spinner />}
        {state === "need-owner" && (
          <>
            <p>An owner needs to sign in on this tablet once to pair it. Do this while online.</p>
            <Link href="/login?next=/pos/pair" className="btn-primary w-full">Owner sign in</Link>
          </>
        )}
        {(state === "ready" || state === "pairing") && (
          <>
            <p className="text-ink-soft">
              Your owner session will be replaced with a POS-only login on this tablet. Staff will unlock it with their PIN.
              Your owner pages won&apos;t be reachable from this tablet afterwards.
            </p>
            <Field label="Tablet name" htmlFor="label">
              <input id="label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <button className="btn-primary w-full" onClick={pair} disabled={state === "pairing"}>
              {state === "pairing" ? "Pairing…" : "Use this tablet as the POS"}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
