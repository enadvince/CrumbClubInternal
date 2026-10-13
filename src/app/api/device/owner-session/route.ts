import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { getServiceSupabase, getSessionContext, mintSession } from "@/lib/supabase/server";
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

  // Independent lookups run together to keep the owner-view switch quick.
  const [{ data: staff }, { data: device }] = await Promise.all([
    admin
      .from("staff")
      .select("id, name, role, user_id, pin_hash")
      .eq("id", body.staffId)
      .eq("business_id", membership.business_id)
      .eq("role", "owner")
      .eq("active", true)
      .maybeSingle(),
    admin.from("memberships").select("label").eq("user_id", user.id).eq("business_id", membership.business_id).maybeSingle(),
  ]);
  const ok = !!staff?.pin_hash && (await bcrypt.compare(body.pin, staff.pin_hash));

  const updated = nextLock(lock, ok, now);
  const saveLock = () => admin.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, ...updated } });
  if (!ok) {
    await saveLock();
    const locked = lockRemaining(updated, now) > 0;
    return NextResponse.json(
      { error: locked ? "Too many wrong PINs. Owner view is locked for 15 minutes." : "That isn't an owner PIN." },
      { status: locked ? 429 : 401 },
    );
  }
  if (!staff.user_id) {
    return NextResponse.json({ error: "This owner PIN isn't linked to an owner login." }, { status: 409 });
  }

  // Reset the failure count (only when there is one to reset) while checking the owner.
  const needsReset = (lock.owner_pin_failures ?? 0) > 0 || lock.owner_pin_locked_until != null;
  const [, { data: ownerMembership }, { data: owner, error: ownerError }] = await Promise.all([
    needsReset ? saveLock() : null,
    // The owner must still own this business.
    admin
      .from("memberships")
      .select("role")
      .eq("user_id", staff.user_id)
      .eq("business_id", membership.business_id)
      .maybeSingle(),
    admin.auth.admin.getUserById(staff.user_id),
  ]);
  if (ownerMembership?.role !== "owner") {
    return NextResponse.json({ error: "This PIN's login no longer owns the business." }, { status: 403 });
  }
  if (ownerError || !owner.user?.email) {
    return NextResponse.json({ error: "Could not find the owner's login." }, { status: 500 });
  }

  // Record the PIN use in the owner's PIN log while minting the owner's session (no email is sent).
  const [, { session, error: sessionError }] = await Promise.all([
    admin.from("pin_uses").insert({
      id: randomUUID(), business_id: membership.business_id, staff_id: staff.id, staff_name: staff.name,
      staff_role: staff.role, action: "owner_view", used_at: new Date().toISOString(), device_user_id: user.id,
      device_label: device?.label ?? null,
    }),
    mintSession(owner.user.email),
  ]);
  if (!session) return NextResponse.json({ error: sessionError ?? "Could not start owner session" }, { status: 500 });
  return NextResponse.json(session);
}
