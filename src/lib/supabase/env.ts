/**
 * Supabase settings. Accepts both the classic key names and the newer
 * "publishable"/"secret" names that the Supabase ↔ Vercel integration may create.
 * NEXT_PUBLIC_* values are inlined at build time, so each is referenced literally.
 */
const publicUrl = () => process.env.NEXT_PUBLIC_SUPABASE_URL;
const publicKey = () =>
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

export function supabaseEnv() {
  const url = publicUrl();
  const anonKey = publicKey();
  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY), then rebuild.",
    );
  }
  return { url, anonKey };
}

export const isSupabaseConfigured = () => Boolean(publicUrl() && publicKey());

/** Server-only key that bypasses RLS (used only to create the POS tablet's login). */
export const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
