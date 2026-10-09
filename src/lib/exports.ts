import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBackupFiles, type BackupData, type BackupFile } from "../../supabase/functions/daily-backup/files.ts";
import { addDays, manilaDayStart } from "./time";

/*
 * Manual exports for owners: the same CSV files as the nightly backup, for a date range.
 * Here the range is by when things happened (sale time, refund time on the tablet), which is
 * what owners expect when they pick "Oct 8". The nightly backup goes by server time instead,
 * so a late-synced order is backed up exactly once.
 */

export type ExportRange = { from: string; to: string }; // YYYY-MM-DD inclusive, Manila

const ORDER_SELECT =
  "*, events(name), staff:staff!transactions_staff_id_fkey(name), voided_by:staff!transactions_voided_by_staff_id_fkey(name), device:pos_devices(device_code)";

async function all<T>(build: (lo: number, hi: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let lo = 0; lo < max; lo += 1000) {
    const { data, error } = await build(lo, lo + 999);
    if (error) throw new Error(error.message);
    const rows = (data as T[]) ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export async function fetchExportData(supabase: SupabaseClient, range: ExportRange): Promise<BackupData> {
  const from = manilaDayStart(range.from);
  const to = manilaDayStart(addDays(range.to, 1));
  const orders = await all<BackupData["orders"][number]>((lo, hi) => supabase.from("transactions").select(ORDER_SELECT)
    .gte("client_created_at", from).lt("client_created_at", to).order("client_created_at").range(lo, hi));
  const lines: BackupData["lines"] = [];
  for (let i = 0; i < orders.length; i += 200) {
    const { data, error } = await supabase.from("transaction_lines")
      .select("id, transaction_id, position, kind, name_snapshot, quantity, unit_price_centavos, line_total_centavos")
      .in("transaction_id", orders.slice(i, i + 200).map((o) => o.id)).order("position");
    if (error) throw new Error(error.message);
    lines.push(...((data as BackupData["lines"]) ?? []));
  }
  const refunds = await all<BackupData["refunds"][number]>((lo, hi) => supabase.from("refunds")
    .select("*, staff:staff!refunds_staff_id_fkey(name), approver:staff!refunds_approved_by_staff_id_fkey(name), order:transactions(order_number), refund_lines(transaction_line_id, quantity, amount_centavos)")
    .gte("created_at_device", from).lt("created_at_device", to).order("created_at_device").range(lo, hi));
  const shifts = await all<BackupData["shifts"][number]>((lo, hi) => supabase.from("shifts")
    .select("*, device:pos_devices(device_code), opener:staff!shifts_opened_by_staff_id_fkey(name), closer:staff!shifts_closed_by_staff_id_fkey(name), approver:staff!shifts_variance_approved_by_staff_id_fkey(name), events(name)")
    .gte("opened_at", from).lt("opened_at", to).order("opened_at").range(lo, hi));
  const drawer = await all<BackupData["drawer"][number]>((lo, hi) => supabase.from("drawer_movements")
    .select("*, staff:staff!drawer_movements_staff_id_fkey(name), approver:staff!drawer_movements_approved_by_staff_id_fkey(name)")
    .gte("created_at_device", from).lt("created_at_device", to).order("created_at_device").range(lo, hi));
  const audit = await all<BackupData["audit"][number]>((lo, hi) => supabase.from("audit_log")
    .select("*, cashier:staff!audit_log_cashier_staff_id_fkey(name), manager:staff!audit_log_manager_staff_id_fkey(name), device:pos_devices(device_code)")
    .gte("server_time", from).lt("server_time", to).order("server_time").range(lo, hi));
  return { orders, lines, voids: orders.filter((o) => o.status === "voided"), refunds, shifts, drawer, audit };
}

export function exportFiles(data: BackupData): BackupFile[] {
  return buildBackupFiles(data);
}

/** Totals for the printable summary. */
export function summarize(d: BackupData) {
  const completed = d.orders.filter((o) => o.status === "completed");
  const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + Number(f(x) || 0), 0);
  const refunds = sum(d.refunds, (r) => r.amount_centavos);
  const items = new Map<string, { quantity: number; revenue: number }>();
  const completedIds = new Set(completed.map((o) => o.id));
  for (const l of d.lines) {
    if (!completedIds.has(l.transaction_id)) continue;
    const it = items.get(l.name_snapshot) ?? { quantity: 0, revenue: 0 };
    it.quantity += l.quantity;
    it.revenue += l.line_total_centavos;
    items.set(l.name_snapshot, it);
  }
  return {
    orders: completed.length,
    gross: sum(completed, (o) => o.subtotal_centavos),
    discounts: sum(completed, (o) => o.discount_centavos),
    voids: { count: d.voids.length, total: sum(d.voids, (o) => o.total_centavos) },
    refunds: { count: d.refunds.length, total: refunds },
    net: sum(completed, (o) => o.total_centavos) - refunds,
    cash: sum(completed.filter((o) => o.payment_method === "cash"), (o) => o.total_centavos),
    qr: sum(completed.filter((o) => o.payment_method === "qr_ph"), (o) => o.total_centavos),
    qrAwaiting: completed.filter((o) => o.payment_status === "awaiting_verification").length,
    shifts: d.shifts,
    topItems: [...items.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)).slice(0, 10),
  };
}
