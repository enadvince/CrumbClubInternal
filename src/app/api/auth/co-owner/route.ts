import { NextResponse } from "next/server";
import { getServiceSupabase, mintSession } from "@/lib/supabase/server";

type PinResult = { ok: boolean; user_id?: string; error?: string; locked_until?: string | null };

/**
 * Co-owner sign-in with email and 4-digit PIN. The database checks the PIN and
 * applies the lockout (5 wrong → 15 minutes; 5 more → until the main owner
 * resets the PIN). On success a session for the co-owner's login is returned.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; pin?: unknown };
  if (typeof body.email !== "string" || typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) {
    return NextResponse.json({ error: "Enter your email and 4-digit PIN." }, { status: 400 });
  }

  const admin = getServiceSupabase();
  const { data, error } = await admin.rpc("co_owner_pin_login", { p_email: body.email, p_pin: body.pin });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as PinResult;
  if (!result.ok || !result.user_id) {
    return NextResponse.json({ error: result.error ?? "Wrong PIN." }, { status: result.locked_until ? 429 : 401 });
  }

  const { data: user, error: userError } = await admin.auth.admin.getUserById(result.user_id);
  if (userError || !user.user?.email) return NextResponse.json({ error: "Could not find your login." }, { status: 500 });
  const { session, error: sessionError } = await mintSession(user.user.email);
  if (!session) return NextResponse.json({ error: sessionError ?? "Could not sign you in" }, { status: 500 });
  return NextResponse.json(session);
}
