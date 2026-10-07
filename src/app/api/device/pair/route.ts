import { NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { getServiceSupabase, getSessionContext } from "@/lib/supabase/server";

/**
 * Creates a dedicated "device" login for the POS tablet. Only an owner can
 * call this. The tablet then signs in as the device, which RLS limits to
 * reading the menu and recording sales through RPCs.
 */
export async function POST(request: Request) {
  const { user, membership } = await getSessionContext();
  if (!user || membership?.role !== "owner") {
    return NextResponse.json({ error: "Only an owner can set up a POS tablet." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { label?: string };
  const label = (body.label ?? "POS tablet").slice(0, 60);
  const email = `pos-${randomUUID()}@devices.crumbclub.invalid`;
  const password = randomBytes(32).toString("base64url");

  const admin = getServiceSupabase();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { kind: "pos_device", business_id: membership.business_id },
  });
  if (createError || !created.user) {
    return NextResponse.json({ error: createError?.message ?? "Could not create device login" }, { status: 500 });
  }

  const { error: memberError } = await admin.from("memberships").insert({
    user_id: created.user.id,
    business_id: membership.business_id,
    role: "device",
    label,
  });
  if (memberError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: memberError.message }, { status: 500 });
  }

  return NextResponse.json({ email, password });
}
