import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { serviceRoleKey, supabaseEnv } from "./env";

export async function getServerSupabase() {
  const { url, anonKey } = supabaseEnv();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component; the proxy refreshes the session instead.
        }
      },
    },
  });
}

/** Service-role client. Server only; bypasses RLS. */
export function getServiceSupabase() {
  const { url } = supabaseEnv();
  const key = serviceRoleKey();
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) is not set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Starts a session for an existing login without its password: a magic-link
 * token is generated and verified right away (no email is sent). Only call
 * this after the server has checked who the caller is (e.g. a PIN).
 */
export async function mintSession(email: string) {
  const admin = getServiceSupabase();
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (linkError || !link.properties?.hashed_token) {
    return { session: null, error: linkError?.message ?? "Could not start session" };
  }
  const { url, anonKey } = supabaseEnv();
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: link.properties.hashed_token });
  if (verifyError || !verified.session) {
    return { session: null, error: verifyError?.message ?? "Could not start session" };
  }
  return {
    session: { access_token: verified.session.access_token, refresh_token: verified.session.refresh_token },
    error: null,
  };
}

export type Membership = { business_id: string; role: "owner" | "device"; business_name: string };

/** Current user and their (first) membership, or nulls. */
export async function getSessionContext() {
  const supabase = await getServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, membership: null as Membership | null };
  const { data } = await supabase
    .from("memberships")
    .select("business_id, role, businesses(name)")
    .eq("user_id", user.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const membership: Membership | null = data
    ? {
        business_id: data.business_id,
        role: data.role,
        business_name: (data.businesses as unknown as { name: string } | null)?.name ?? "",
      }
    : null;
  return { supabase, user, membership };
}
