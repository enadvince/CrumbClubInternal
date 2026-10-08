"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useConfirm } from "@/components/ConfirmModal";
import { getSupabase } from "@/lib/supabase/client";
import { useOwner } from "../OwnerContext";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/time";

type Owner = { user_id: string; email: string; name: string | null; joined_at: string };
type Invite = {
  id: string; email: string; created_at: string; expires_at: string;
  accepted_at: string | null; revoked_at: string | null;
};
type Sent = { email: string; link: string; emailed: boolean; emailError: string | null };

function inviteStatus(i: Invite): { label: string; className: string } {
  if (i.accepted_at) return { label: "✓ Joined", className: "bg-ok-light text-ok" };
  if (i.revoked_at) return { label: "Cancelled", className: "bg-crust text-ink-soft" };
  if (new Date(i.expires_at) <= new Date()) return { label: "Expired", className: "bg-crust text-ink-soft" };
  return { label: "Pending", className: "bg-warn-light text-warn" };
}

/** Everyone with access to the owner pages, and email invites for new owners. */
export default function OwnersPage() {
  const [ask, confirmEl] = useConfirm();
  const { businessId, userId } = useOwner();
  const [owners, setOwners] = useState<Owner[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);

  const load = useCallback(async () => {
    const supabase = getSupabase();
    const [o, i] = await Promise.all([
      supabase.rpc("business_owners", { p_business: businessId }),
      supabase.from("owner_invites")
        .select("id, email, created_at, expires_at, accepted_at, revoked_at")
        .order("created_at", { ascending: false }).limit(50),
    ]);
    if (o.error || i.error) setError(errorMessage(o.error ?? i.error));
    setOwners((o.data as Owner[]) ?? []);
    setInvites((i.data as Invite[]) ?? []);
  }, [businessId]);
  useEffect(() => { load(); }, [load]);

  async function revoke(i: Invite) {
    if (!(await ask({ title: "Cancel invite?", body: `Cancel the invite for ${i.email}? The link will stop working.`, confirmLabel: "Cancel invite" }))) return;
    const { error } = await getSupabase().rpc("revoke_owner_invite", { p_invite_id: i.id });
    if (error) setError(errorMessage(error));
    load();
  }

  async function resend(email: string) {
    setError(null);
    const res = await fetch("/api/owners/invite", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setError(body.error ?? "Could not send the invite");
    else setSent(body as Sent);
    load();
  }

  // Hide replaced invites: show the newest one per email.
  const latest = invites.filter((inv, idx) => invites.findIndex((x) => x.email === inv.email) === idx);

  return (
    <>
      {confirmEl}
      <PageHeader
        title="Owners"
        subtitle="People who can sign in to the owner pages. Invite someone by email to give them access."
        actions={<button className="btn-primary" onClick={() => setInviting(true)}>+ Invite owner</button>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {sent && <SentNotice sent={sent} onClose={() => setSent(null)} />}

      {!owners ? <Spinner /> : (
        <div className="card mb-6 divide-y divide-crust-dark">
          {owners.map((o) => (
            <div key={o.user_id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-40 flex-1">
                <p className="font-semibold">{o.name ?? o.email} {o.user_id === userId && <span className="badge bg-crust text-ink-soft">You</span>}</p>
                <p className="text-sm text-ink-soft">{o.email} · Owner since {formatDateTime(o.joined_at)}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-2 text-lg font-bold">Invites</h2>
      {latest.length === 0 ? <EmptyState>No invites yet.</EmptyState> : (
        <div className="card divide-y divide-crust-dark">
          {latest.map((i) => {
            const status = inviteStatus(i);
            const open = status.label === "Pending";
            return (
              <div key={i.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-40 flex-1">
                  <p className="font-semibold">{i.email} <span className={`badge ${status.className}`}>{status.label}</span></p>
                  <p className="text-sm text-ink-soft">
                    Sent {formatDateTime(i.created_at)}
                    {open && ` · Expires ${formatDateTime(i.expires_at)}`}
                    {i.accepted_at && ` · Joined ${formatDateTime(i.accepted_at)}`}
                  </p>
                </div>
                {!i.accepted_at && <button className="btn-secondary" onClick={() => resend(i.email)}>{open ? "Resend" : "Invite again"}</button>}
                {open && <button className="btn-ghost" onClick={() => revoke(i)}>Cancel</button>}
              </div>
            );
          })}
        </div>
      )}

      <InviteModal open={inviting} onClose={() => setInviting(false)} onSent={(s) => { setInviting(false); setSent(s); load(); }} />
    </>
  );
}

function SentNotice({ sent, onClose }: { sent: Sent; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(sent.link).then(() => setCopied(true)).catch(() => {});
  }
  return (
    <Notice tone={sent.emailed ? "ok" : "warn"} className="mb-4">
      <p>
        {sent.emailed
          ? `Invite sent to ${sent.email}.`
          : `The invite for ${sent.email} was created, but the email could not be sent${sent.emailError ? ` (${sent.emailError})` : ""}. Send them this link yourself:`}
      </p>
      {!sent.emailed && <p className="mt-1 break-all font-mono text-xs">{sent.link}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn-secondary text-sm" onClick={copy}>{copied ? "✓ Copied" : "Copy invite link"}</button>
        <button className="btn-ghost text-sm" onClick={onClose}>Dismiss</button>
      </div>
    </Notice>
  );
}

function InviteModal({ open, onClose, onSent }: { open: boolean; onClose: () => void; onSent: (s: Sent) => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => { if (open) { setEmail(""); setError(null); } }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const res = await fetch("/api/owners/invite", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
    }).catch(() => null);
    setSending(false);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) return setError(body?.error ?? "Could not send the invite. Check your connection.");
    onSent(body as Sent);
  }

  return (
    <Modal open={open} onClose={onClose} title="Invite an owner">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Email" htmlFor="invite-email" hint="They get a link to create an account. It works once and expires in 7 days.">
          <input id="invite-email" type="email" autoFocus required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Notice tone="warn">Owners can see all sales, costs and staff, and can invite other owners.</Notice>
        <button className="btn-primary w-full" disabled={sending}>{sending ? "Sending…" : "Send invite"}</button>
      </form>
    </Modal>
  );
}
