import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { getServiceSupabase, getSessionContext } from "@/lib/supabase/server";
import { supabaseEnv } from "@/lib/supabase/env";
import { lockRemaining, nextLock, type OwnerPinLock } from "@/lib/ownerPinLock";

/**
 * Lets an owner open owner view on the POS tablet with their PIN. Only the
 * tablet's device login can call this. The PIN is checked here against the
 * owner's staff row (not just on the tablet), failures lock the tablet out
 * for a while, and on success a session for the owner's own login is returned.
 */
export async function POST(request: Request) {
  const { user, membership } = await getSessionContext();
  if (!user || membership?.role !== "device") {
    return NextResponse.json({ error: "Only the POS tablet can open owner view this way." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { staffId?: string; pin?: string };
  if (typeof body.staffId !== "string" || typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) {
    return NextResponse.json({ error: "Enter a 4-digit owner PIN." }, { status: 400 });
  }

  const admin = getServiceSupabase();
  const lock = (user.app_metadata ?? {}) as OwnerPinLock;
  const now = Date.now();
  const wait = lockRemaining(lock, now);
  if (wait > 0) {
    return NextResponse.json({ error: `Too many wrong PINs. Try again in ${Math.ceil(wait / 60000)} min.` }, { status: 429 });
  }

  const { data: staff } = await admin
    .from("staff")
    .select("id, name, role, user_id, pin_hash")
    .eq("id", body.staffId)
    .eq("business_id", membership.business_id)
    .eq("role", "owner")
    .eq("active", true)
    .maybeSingle();
  const ok = !!staff?.pin_hash && (await bcrypt.compare(body.pin, staff.pin_hash));

  const updated = nextLock(lock, ok, now);
  await admin.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, ...updated } });
  if (!ok) {
    const locked = lockRemaining(updated, now) > 0;
    return NextResponse.json(
      { error: locked ? "Too many wrong PINs. Owner view is locked for 15 minutes." : "That isn't an owner PIN." },
      { status: locked ? 429 : 401 },
    );
  }
  if (!staff.user_id) {
    return NextResponse.json({ error: "This owner PIN isn't linked to an owner login." }, { status: 409 });
  }

  // The owner must still own this business.
  const { data: ownerMembership } = await admin
    .from("memberships")
    .select("role")
    .eq("user_id", staff.user_id)
    .eq("business_id", membership.business_id)
    .maybeSingle();
  if (ownerMembership?.role !== "owner") {
    return NextResponse.json({ error: "This PIN's login no longer owns the business." }, { status: 403 });
  }

  const { data: owner, error: ownerError } = await admin.auth.admin.getUserById(staff.user_id);
  if (ownerError || !owner.user?.email) {
    return NextResponse.json({ error: "Could not find the owner's login." }, { status: 500 });
  }

  // Record the PIN use in the owner's PIN log.
  const { data: device } = await admin
    .from("memberships").select("label").eq("user_id", user.id).eq("business_id", membership.business_id).maybeSingle();
  await admin.from("pin_uses").insert({
    id: randomUUID(), business_id: membership.business_id, staff_id: staff.id, staff_name: staff.name,
    staff_role: staff.role, action: "owner_view", used_at: new Date().toISOString(), device_user_id: user.id,
    device_label: device?.label ?? null,
  });

  // Mint a session for the owner: a magic link token that is verified right away (no email is sent).
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: owner.user.email });
  if (linkError || !link.properties?.hashed_token) {
    return NextResponse.json({ error: linkError?.message ?? "Could not start owner session" }, { status: 500 });
  }
  const { url, anonKey } = supabaseEnv();
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
  if (verifyError || !verified.session) {
    return NextResponse.json({ error: verifyError?.message ?? "Could not start owner session" }, { status: 500 });
  }

  return NextResponse.json({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
}
