import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase/server";

export type LoginKind = { kind: "owner" | "co_owner" | "unknown"; setup_open: boolean };

/**
 * Step one of signing in: which second step an email needs. The main owner
 * enters a password, a co-owner their PIN. setup_open lets the very first
 * owner create an account while no business exists yet.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  if (typeof body.email !== "string" || !body.email.includes("@")) {
    return NextResponse.json({ error: "Enter your email address." }, { status: 400 });
  }
  const { data, error } = await getServiceSupabase().rpc("login_kind", { p_email: body.email });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data as LoginKind);
}
