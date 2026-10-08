import type { SupabaseClient } from "@supabase/supabase-js";
import type { Snapshot } from "../pos/types";
import { SyncError, type ClaimedDevice, type SyncTransport } from "./sync";

const TIMEOUT_MS = 15_000;

/**
 * Whether a failed call can never succeed if retried unchanged.
 *  - Retryable: no response (offline, timeout, aborted), 5xx, 429, 408, 401 (token refresh)
 *    and 404 (a function not deployed yet during a rollout).
 *  - Permanent: data the server rejects (Postgres 22xxx, 23xxx, P0xxx), permission
 *    denied (42501), and any other 4xx. These are kept as "failed" for manual review.
 */
export function isPermanentFailure(status: number | undefined, code: string | undefined): boolean {
  if (code && /^(22|23|P0)/.test(code)) return true;
  if (code === "42501") return true;
  if (!status) return false;
  if (status >= 500 || status === 429 || status === 408 || status === 401 || status === 404) return false;
  return status >= 400;
}

/** Kept for callers that only have a Postgres error code. */
export function isPermanentError(code: string | undefined): boolean {
  return isPermanentFailure(undefined, code);
}

type RpcError = { message: string; code?: string } | null;

function check(error: RpcError, status: number | undefined, what: string) {
  if (!error) return;
  throw new SyncError(`${what}: ${error.message || "network error"}`, isPermanentFailure(status, error.code));
}

export function supabaseTransport(supabase: SupabaseClient, appVersion = "1"): SyncTransport {
  const rpc = async <T,>(fn: string, args: Record<string, unknown>, what: string): Promise<T> => {
    try {
      const { data, error, status } = await supabase.rpc(fn, args).abortSignal(AbortSignal.timeout(TIMEOUT_MS));
      check(error, status, what);
      return data as T;
    } catch (err) {
      if (err instanceof SyncError) throw err;
      throw new SyncError(`${what}: ${err instanceof Error ? err.message : "network error"}`, false);
    }
  };

  return {
    async recordSale(sale) {
      // "ok" and "duplicate" both mean the server has this sale.
      // device_sent_at lets the server measure this tablet's clock drift.
      await rpc("record_sale", { p_sale: { ...sale, device_sent_at: new Date().toISOString() } }, "Sale");
    },
    async voidSale(a) {
      await rpc("void_sale", { p_transaction_id: a.transaction_id, p_reason: a.reason, p_staff_id: a.staff_id, p_voided_at: a.voided_at }, "Undo");
    },
    async adjustStock(payload) {
      await rpc("adjust_stock", { p_adjustment: payload }, "Stock adjustment");
    },
    async setAvailability(a) {
      await rpc("set_availability", { p_event_product_id: a.event_product_id, p_available: a.available }, "Availability");
    },
    async logPinUse(use) {
      await rpc("log_pin_use", { p_use: use }, "PIN log");
    },
    async fetchSnapshot(eventId) {
      return rpc<Snapshot>("pos_snapshot", { p_event_id: eventId }, "Menu download");
    },
    async claimDeviceCode(label) {
      return rpc<ClaimedDevice>("claim_device_code", { p_label: label ?? null }, "Device registration");
    },
    async ping() {
      return rpc<{ server_time: string }>("pos_ping", {}, "Health check");
    },
    async heartbeat(count, oldest) {
      await rpc("device_heartbeat", { p_unsynced_count: count, p_oldest_unsynced_at: oldest, p_app_version: appVersion }, "Heartbeat");
    },
  };
}
