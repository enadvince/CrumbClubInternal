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
import type { LoginKind } from "@/app/api/auth/login-kind/route";

// email: ask for the email first. Then the main owner enters a password, a
// co-owner their PIN, and (only before any business exists) the first owner signs up.
type Step = "email" | "password" | "pin" | "signup";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Something went wrong");
  return data as T;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function done() {
    router.replace(params.get("next") ?? "/");
    router.refresh();
  }

  function restart() {
    setStep("email");
    setPassword("");
    setPin("");
    setError(null);
    setInfo(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const supabase = getSupabase();
      if (step === "email") {
        const { kind, setup_open } = await postJson<LoginKind>("/api/auth/login-kind", { email });
        if (kind === "owner") setStep("password");
        else if (kind === "co_owner") setStep("pin");
        else if (setup_open) setStep("signup");
        else setError("This email isn't registered. Ask the owner to add you as a co-owner.");
      } else if (step === "password") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        done();
      } else if (step === "pin") {
        const session = await postJson<{ access_token: string; refresh_token: string }>("/api/auth/co-owner", { email, pin });
        const { error } = await supabase.auth.setSession(session);
        if (error) throw error;
        done();
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session) {
          router.replace("/setup");
        } else {
          setInfo("Check your email to confirm your account, then sign in.");
          restart();
        }
      }
    } catch (err) {
      setError(errorMessage(err));
      if (step === "pin") setPin("");
    } finally {
      setBusy(false);
    }
  }

  const title = { email: "Sign in", password: "Owner sign in", pin: "Co-owner sign in", signup: "Create owner account" }[step];
  const button = { email: "Proceed", password: "Sign in", pin: "Sign in", signup: "Create account" }[step];

  return (
    <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
      <h1 className="text-xl font-bold">{title}</h1>
      {!isSupabaseConfigured() && (
        <Notice tone="warn">
          Supabase isn&apos;t configured in this build. Add the Supabase environment variables in Vercel, then redeploy (they are read when the site is built).
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {info && <Notice tone="ok">{info}</Notice>}
      <Field label="Email" htmlFor="email">
        <input id="email" type="email" autoComplete="email" required readOnly={step !== "email"} autoFocus={step === "email"}
          className={`input ${step !== "email" ? "bg-crust" : ""}`} value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {(step === "password" || step === "signup") && (
        <Field label="Password" htmlFor="password" hint={step === "signup" ? "At least 8 characters." : undefined}>
          <SecretInput id="password" autoFocus minLength={8} required
            autoComplete={step === "signup" ? "new-password" : "current-password"}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      )}
      {step === "pin" && (
        <Field label="Your 4-digit PIN" htmlFor="pin">
          <SecretInput id="pin" autoFocus required inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4}
            className="text-center text-2xl tracking-[0.6em]" value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
        </Field>
      )}
      <button className="btn-primary w-full" disabled={busy || (step === "pin" && pin.length !== 4)}>
        {busy ? "Please wait…" : button}
      </button>
      {step !== "email" && (
        <button type="button" className="btn-ghost w-full text-sm" onClick={restart}>Use a different email</button>
      )}
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
