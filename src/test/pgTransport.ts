/*
 * Test-only: a SyncTransport that calls the real SQL functions in a local Postgres
 * (the throwaway database from supabase/tests/run.sh), as a given Supabase user.
 * Lets the integration tests run the real SyncEngine against the real RPCs.
 */
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { isPermanentFailure } from "../lib/offline/transport";
import { SyncError, type SyncTransport } from "../lib/offline/sync";
import type { Snapshot } from "../lib/pos/types";

export function pgConfig() {
  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "postgres",
    database: process.env.PGDATABASE ?? "postgres",
  };
}

/** Runs one statement as `userId` (role authenticated), like a PostgREST request. */
export async function asUser<T = unknown>(db: Client, userId: string | null, sql: string, params: unknown[] = []): Promise<T> {
  try {
    await db.query("begin");
    if (userId) {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
      await db.query("set local role authenticated");
    }
    const res = await db.query(sql, params);
    await db.query("commit");
    return (res.rows[0] ? Object.values(res.rows[0])[0] : null) as T;
  } catch (err) {
    await db.query("rollback").catch(() => {});
    throw err;
  }
}

/** A transport for the tablet's device login. `online` simulates the network. */
export function pgTransport(db: Client, deviceUserId: string) {
  const state = { online: true };
  const call = async <T,>(fn: string, args: unknown[] = []): Promise<T> => {
    if (!state.online) throw new SyncError("Failed to fetch", false);
    const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
    try {
      return await asUser<T>(db, deviceUserId, `select public.${fn}(${placeholders}) as r`, args);
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw new SyncError(`${fn}: ${(err as Error).message}`, isPermanentFailure(undefined, code));
    }
  };
  const transport: SyncTransport = {
    recordSale: async (sale) => { await call("record_sale", [JSON.stringify({ ...sale, device_sent_at: new Date().toISOString() })]); },
    voidSale: async (a) => { await call("void_sale", [a.transaction_id, a.reason, a.staff_id, a.voided_at]); },
    adjustStock: async (p) => { await call("adjust_stock", [JSON.stringify(p)]); },
    setAvailability: async (a) => { await call("set_availability", [a.event_product_id, a.available]); },
    logPinUse: async (u) => { await call("log_pin_use", [JSON.stringify(u)]); },
    fetchSnapshot: async (eventId) => call<Snapshot>("pos_snapshot", [eventId]),
    heartbeat: async (count, oldest) => { await call("device_heartbeat", [count, oldest, "test"]); },
    claimDeviceCode: async (label) => call("claim_device_code", [label ?? null]),
    ping: async () => call("pos_ping"),
    uploadPaymentPhoto: async () => { /* Storage isn't part of the local harness */ },
    voidOrder: async (p) => { await call("void_order", [JSON.stringify(p)]); },
    refundOrder: async (p) => { await call("refund_order", [JSON.stringify(p)]); },
    logAudit: async (e) => { await call("log_audit", [JSON.stringify(e)]); },
    openShift: async (p) => { await call("open_shift", [JSON.stringify(p)]); },
    closeShift: async (p) => { await call("close_shift", [JSON.stringify(p)]); },
    drawerMovement: async (p) => { await call("record_drawer_movement", [JSON.stringify(p)]); },
  };
  return { transport, state };
}

/** A fresh business with an owner (PIN 9001), the sample menu live, and a paired tablet. */
export async function createFixture(db: Client) {
  const owner = randomUUID();
  const device = randomUUID();
  await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [owner, `${owner}@test`, device, `${device}@test`]);
  const business = (await db.query("select public._create_business_for($1, 'Integration Biz', 'Owner I', '9001') as id", [owner])).rows[0].id as string;
  const event = (await db.query("select public.load_sample_data($1) as id", [business])).rows[0].id as string;
  await db.query("update public.events set status = 'live' where id = $1", [event]);
  await db.query("insert into public.memberships (user_id, business_id, role, label) values ($1, $2, 'device', 'Integration tablet')", [device, business]);
  return { owner, device, business, event };
}
