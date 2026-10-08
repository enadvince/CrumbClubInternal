import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/supabase/server";
import { inviteEmailContent, sendInviteEmail } from "@/lib/inviteEmail";

type Invite = { id: string; email: string; token: string; business_name: string; invited_by_name: string | null };

/**
 * An owner invites someone to be an owner. The invite (and its one-time token)
 * is created under the owner's own session, so the database checks ownership.
 * The link is emailed and also returned, so the owner can share it by hand.
 */
export async function POST(request: Request) {
  const { supabase, user, membership } = await getSessionContext();
  if (!user || membership?.role !== "owner") {
    return NextResponse.json({ error: "Only an owner can invite owners." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  if (typeof body.email !== "string") return NextResponse.json({ error: "Enter an email address." }, { status: 400 });

  const { data, error } = await supabase.rpc("create_owner_invite", { p_email: body.email });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const invite = data as Invite;

  const origin = (process.env.SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
  const link = `${origin}/invite/${invite.token}`;
  const emailError = await sendInviteEmail(
    invite.email,
    inviteEmailContent({ businessName: invite.business_name, inviterName: invite.invited_by_name, link }),
  );

  return NextResponse.json({ id: invite.id, email: invite.email, link, emailed: !emailError, emailError });
}
