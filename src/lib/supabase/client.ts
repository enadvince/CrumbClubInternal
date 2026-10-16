"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseEnv } from "./env";

let client: SupabaseClient | null = null;

/** How long a read may hang before it is abandoned and tried again. */
export const READ_TIMEOUT_MS = 12_000;

/**
 * On a weak connection a request can stall for a minute or more with no error,
 * leaving a page on its spinner. Reads (GET/HEAD) that the caller didn't give
 * their own signal get a timeout and one fresh retry; writes are left alone so
 * nothing is ever sent twice.
 */
export function withReadTimeout(baseFetch: typeof fetch, timeoutMs = READ_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if ((method !== "GET" && method !== "HEAD") || init?.signal) return baseFetch(input, init);
    try {
      return await baseFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "TimeoutError")) throw e;
      return baseFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    }
  };
}

/** Browser Supabase client (singleton). Session lives in cookies, so it is readable offline. */
export function getSupabase(): SupabaseClient {
  if (!client) {
    const { url, anonKey } = supabaseEnv();
    client = createBrowserClient(url, anonKey, { global: { fetch: withReadTimeout((...args) => fetch(...args)) } });
  }
  return client;
}
