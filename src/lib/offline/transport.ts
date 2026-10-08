import type { SupabaseClient } from "@supabase/supabase-js";
import type { Snapshot } from "../pos/types";
import { SyncError, type ClaimedDevice, type SyncTransport } from "./sync";

const TIMEOUT_MS = 15_000;

/**
 * Postgres errors the server raises on bad data are permanent (retrying the
 * same payload can never succeed). Everything else — network failures,
 * timeouts, auth refreshes, 5xx — is transient and retried.
 */
export function isPermanentError(code: string | undefined): boolean {
  if (!code) return false;
  return /^(22|23|P0)/.test(code);
}

type RpcError = { message: string; code?: string } | null;

function check(error: RpcError, what: string) {
  if (!error) return;
  throw new SyncError(`${what}: ${error.message || "network error"}`, isPermanentError(error.code));
}

export function supabaseTransport(supabase: SupabaseClient, appVersion = "1"): SyncTransport {
  const rpc = async <T,>(fn: string, args: Record<string, unknown>, what: string): Promise<T> => {
    try {
      const { data, error } = await supabase.rpc(fn, args).abortSignal(AbortSignal.timeout(TIMEOUT_MS));
      check(error, what);
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
