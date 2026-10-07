export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export default async function Home() {
  if (!isSupabaseConfigured()) redirect("/login");
  const { user, membership } = await getSessionContext();
  if (!user) redirect("/login");
  if (!membership) redirect("/setup");
  redirect(membership.role === "device" ? "/pos" : "/admin/dashboard");
}
