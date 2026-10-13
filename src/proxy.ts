import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured, supabaseEnv } from "@/lib/supabase/env";

/**
 * Keeps the Supabase auth cookie fresh and guards owner pages. The POS page is
 * deliberately not guarded here: it must load from the service worker cache
 * with no network, so it checks the (cookie) session on the client instead.
 */
export async function proxy(request: NextRequest) {
  if (!isSupabaseConfigured()) return NextResponse.next();
  const { url, anonKey } = supabaseEnv();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getClaims verifies the JWT locally (asymmetric signing keys), so most
  // requests skip a round trip to Supabase Auth; it still refreshes an expired
  // session, and falls back to the Auth server for legacy symmetric keys.
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub && request.nextUrl.pathname.startsWith("/admin")) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return response;
}

export const config = {
  matcher: ["/", "/admin/:path*", "/login", "/setup", "/api/:path*"],
};
