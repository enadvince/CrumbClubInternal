import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase/server";

type InviteInfo = { email: string; status: "pending" | "accepted" | "revoked" | "expired"; account_exists: boolean };

/**
 * First step of accepting an owner invite: creates the invitee's login for the
 * invited email. Holding the one-time link stands in for confirming the email.
 * The browser then signs in and calls accept_owner_invite(), which re-checks
 * the token and email and adds the owner membership.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
  if (typeof body.token !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "Missing invite or password." }, { status: 400 });
  }
  if (body.password.length < 8) {
    return NextResponse.json({ error: "Use a password of at least 8 characters." }, { status: 400 });
  }

  const admin = getServiceSupabase();
  const { data, error } = await admin.rpc("get_owner_invite", { p_token: body.token });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const invite = data as InviteInfo | null;
  if (!invite) return NextResponse.json({ error: "This invite link is not valid." }, { status: 404 });
  if (invite.status !== "pending") {
    return NextResponse.json({ error: `This invite is ${invite.status}. Ask an owner for a new one.` }, { status: 410 });
  }
  if (invite.account_exists) return NextResponse.json({ email: invite.email, accountExists: true });

  const { error: createError } = await admin.auth.admin.createUser({
    email: invite.email,
    password: body.password,
    email_confirm: true,
  });
  if (createError) {
    // Created in the meantime (e.g. a double submit): the browser signs in instead.
    if (/already/i.test(createError.message)) return NextResponse.json({ email: invite.email, accountExists: true });
    return NextResponse.json({ error: createError.message }, { status: 400 });
  }
  return NextResponse.json({ email: invite.email, accountExists: false });
}
