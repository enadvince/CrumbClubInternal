"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { Field, Logo, Notice, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/errors";

type Invite = {
  email: string;
  business_name: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  account_exists: boolean;
};

const STATUS_MESSAGE: Record<Exclude<Invite["status"], "pending">, string> = {
  accepted: "This invite has already been used. Sign in with the account you created.",
  revoked: "This invite was cancelled. Ask an owner to send you a new one.",
  expired: "This invite has expired. Ask an owner to send you a new one.",
};

/** Where an invited owner lands from the email: create the account, then join the business. */
export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [invite, setInvite] = useState<Invite | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSupabase().rpc("get_owner_invite", { p_token: token }).then(({ data, error }) => {
      if (error) setError(errorMessage(error));
      setInvite((data as Invite | null) ?? null);
    });
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!invite) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabase();
      let accountExists = invite.account_exists;
      if (!accountExists) {
        const res = await fetch("/api/invites/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, password }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; accountExists?: boolean };
        if (!res.ok) throw new Error(body.error ?? "Could not create your account");
        if (body.accountExists) {
          accountExists = true;
          setInvite({ ...invite, account_exists: true });
        }
      }
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: invite.email, password });
      if (signInError) {
        throw new Error(
          accountExists
            ? "That password is not right for this email. Use the password of your existing account."
            : signInError.message,
        );
      }
      const { error: acceptError } = await supabase.rpc("accept_owner_invite", { p_token: token, p_name: name, p_pin: pin });
      if (acceptError) throw acceptError;
      router.replace("/admin/dashboard");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <Logo className="text-3xl text-caramel" />
      {invite === undefined ? <Spinner /> : !invite ? (
        <div className="card w-full max-w-md space-y-4 p-6">
          <h1 className="text-xl font-bold">Invite not found</h1>
          <Notice tone="danger">{error ?? "This invite link is not valid. Check that you opened the whole link from the email."}</Notice>
        </div>
      ) : invite.status !== "pending" ? (
        <div className="card w-full max-w-md space-y-4 p-6">
          <h1 className="text-xl font-bold">Join {invite.business_name}</h1>
          <Notice tone="warn">{STATUS_MESSAGE[invite.status]}</Notice>
          <a href="/login" className="btn-secondary w-full">Go to sign in</a>
        </div>
      ) : (
        <form onSubmit={submit} className="card w-full max-w-md space-y-4 p-6">
          <div>
            <h1 className="text-xl font-bold">Join {invite.business_name} as an owner</h1>
            <p className="mt-1 text-sm text-ink-soft">
              {invite.account_exists
                ? "You already have an account. Enter its password to add this business."
                : "Create your account to get access to the owner pages."}
            </p>
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          <Field label="Email" htmlFor="email">
            <input id="email" type="email" readOnly className="input bg-crust" value={invite.email} />
          </Field>
          <Field label={invite.account_exists ? "Password" : "Choose a password"} htmlFor="password" hint={invite.account_exists ? undefined : "At least 8 characters."}>
            <input id="password" type="password" required minLength={8} className="input"
              autoComplete={invite.account_exists ? "current-password" : "new-password"}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Your name (shown on sales you ring up)" htmlFor="owner-name">
            <input id="owner-name" required className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Your 4-digit PIN" htmlFor="pin" hint="Unlocks the owner menu on the POS tablet and lets you ring up sales.">
            <input id="pin" required type="password" inputMode="numeric" autoComplete="off" pattern="\d{4}" maxLength={4}
              className="input tracking-[0.5em]" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
          </Field>
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Please wait…" : invite.account_exists ? "Sign in and join" : "Create account and join"}
          </button>
        </form>
      )}
    </main>
  );
}
