import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getServiceSupabase, getSessionContext } from "@/lib/supabase/server";

/**
 * The main owner adds a co-owner (name, email, PIN). Co-owners sign in with
 * email + PIN, so their login gets a random password nobody knows. The
 * database (add_co_owner) checks that the caller is the main owner.
 */
export async function POST(request: Request) {
  const { supabase, user, membership } = await getSessionContext();
  if (!user || membership?.role !== "owner") {
    return NextResponse.json({ error: "Only the main owner can add co-owners." }, { status: 403 });
  }
  const { data: isMain } = await supabase.rpc("is_main_owner", { p_business: membership.business_id });
  if (!isMain) return NextResponse.json({ error: "Only the main owner can add co-owners." }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { email?: unknown; name?: unknown; pin?: unknown };
  if (typeof body.email !== "string" || typeof body.name !== "string" || typeof body.pin !== "string") {
    return NextResponse.json({ error: "Enter a name, email and PIN." }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (!/^\d{4}$/.test(body.pin)) return NextResponse.json({ error: "PIN must be exactly 4 digits." }, { status: 400 });

  // Create the login, or reuse one that exists for this email (e.g. an earlier sign-up).
  const admin = getServiceSupabase();
  const password = () => randomBytes(32).toString("base64url");
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password: password(), email_confirm: true,
  });
  if (createError && !/already/i.test(createError.message)) {
    return NextResponse.json({ error: createError.message }, { status: 400 });
  }

  const { data: userId, error } = await supabase.rpc("add_co_owner", { p_email: email, p_name: body.name, p_pin: body.pin });
  if (error) {
    if (created?.user) await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  // An existing login's old password must not keep working.
  if (!created?.user) await admin.auth.admin.updateUserById(userId as string, { password: password() });

  return NextResponse.json({ userId });
}
