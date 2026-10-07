"use client";
import { getSupabase } from "@/lib/supabase/client";
import { getDb, KV } from "@/lib/offline/db";

/**
 * Owner view on the POS tablet. The tablet normally runs as its restricted
 * device login. To open the owner pages, the device login is parked in
 * IndexedDB and swapped for an owner session obtained with the owner's PIN.
 * Returning to the POS signs the owner out on this tablet and restores the
 * device login, so the tablet never stays signed in as the owner.
 */
type ParkedSession = { access_token: string; refresh_token: string; userId: string };

/** Minutes of no taps before owner view returns to the POS on its own. */
export const OWNER_VIEW_IDLE_MS = 5 * 60 * 1000;

export async function enterOwnerView(staffId: string, pin: string): Promise<void> {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("This tablet isn't signed in. Connect to the internet and try again.");

  const res = await fetch("/api/device/owner-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ staffId, pin }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "Couldn't open owner view");

  // Park the tablet's own login first, so it can always be restored.
  const { data: { session: current } } = await supabase.auth.getSession();
  const device = current ?? session;
  await getDb().setKv<ParkedSession>(KV.deviceSession, {
    access_token: device.access_token,
    refresh_token: device.refresh_token,
    userId: device.user.id,
  });
  const { error } = await supabase.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
  if (error) {
    await restoreDeviceSession();
    throw error;
  }
}

/** True while this tablet is in owner view (the device login is parked). */
export async function isTabletOwnerView(): Promise<boolean> {
  return !!(await getDb().getKv<ParkedSession | null>(KV.deviceSession));
}

/**
 * Signs the owner out on this tablet and puts the device login back.
 * Returns false if there was nothing to restore or it couldn't be restored yet.
 */
export async function restoreDeviceSession(): Promise<boolean> {
  const db = getDb();
  const parked = await db.getKv<ParkedSession | null>(KV.deviceSession);
  if (!parked) return false;
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (session && session.user.id !== parked.userId) await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  const { error } = await supabase.auth.setSession({ access_token: parked.access_token, refresh_token: parked.refresh_token });
  // Keep it parked on failure (e.g. offline) so the next attempt can try again.
  if (error) return false;
  await db.setKv(KV.deviceSession, null);
  return true;
}
