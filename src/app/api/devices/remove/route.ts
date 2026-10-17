import { NextResponse } from "next/server";
import { getServiceSupabase, getSessionContext } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";

/** About 100 years: Supabase has no "forever". */
const BAN_FOREVER = "876000h";

/**
 * Removes a paired POS tablet (owners only). The remove_device RPC, run as the
 * owner, checks ownership and takes away the tablet's access at once. Its login
 * is then banned so it can't refresh its session: the tablet is signed out. The
 * login itself is kept because its past sales point at it.
 */
export async function POST(request: Request) {
  const { supabase, user, membership } = await getSessionContext();
  if (!user || membership?.role !== "owner") {
    return NextResponse.json({ error: "Only an owner can remove a tablet." }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as { deviceId?: string };
  if (typeof body.deviceId !== "string") return NextResponse.json({ error: "Which tablet?" }, { status: 400 });

  const { data, error } = await supabase.rpc("remove_device", { p_device_id: body.deviceId });
  if (error) return NextResponse.json({ error: errorMessage(error) }, { status: 400 });

  const deviceUserId = (data as { device_user_id: string | null }).device_user_id;
  if (deviceUserId) {
    const { error: banError } = await getServiceSupabase().auth.admin.updateUserById(deviceUserId, { ban_duration: BAN_FOREVER });
    if (banError) {
      return NextResponse.json(
        { error: `The tablet lost access, but it couldn't be signed out: ${banError.message}. It will be once its login expires.` },
        { status: 500 },
      );
    }
  }
  return NextResponse.json({ ok: true });
}
