"use client";
import { useState, type FormEvent } from "react";
import { SecretInput } from "@/components/SecretInput";
import { ContactButton } from "@/components/ContactButton";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { Field, Logo, Notice } from "@/components/ui";
import { errorMessage } from "@/lib/errors";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const supabase = getSupabase();
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(params.get("next") ?? "/");
        router.refresh();
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session) {
          router.replace("/setup");
        } else {
          setInfo("Check your email to confirm your account, then sign in.");
          setMode("signin");
        }
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
      <h1 className="text-xl font-bold">{mode === "signin" ? "Owner sign in" : "Create owner account"}</h1>
      {!isSupabaseConfigured() && (
        <Notice tone="warn">
          Supabase isn&apos;t configured in this build. Add the Supabase environment variables in Vercel, then redeploy (they are read when the site is built).
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {info && <Notice tone="ok">{info}</Notice>}
      <Field label="Email" htmlFor="email">
        <input id="email" type="email" autoComplete="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Password" htmlFor="password">
        <SecretInput id="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <button className="btn-primary w-full" disabled={busy}>{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</button>
      <button type="button" className="btn-ghost w-full text-sm" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
        {mode === "signin" ? "First time? Create the owner account" : "Already have an account? Sign in"}
      </button>
      <p className="text-center text-sm text-ink-soft">
        Staff: use the POS tablet and your 4-digit PIN.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <Logo className="text-3xl text-caramel" />
      <Suspense>
        <LoginForm />
      </Suspense>
      <ContactButton page="login" />
    </main>
  );
}
