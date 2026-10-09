// Nightly backup (Supabase Edge Function, Deno).
// Triggered by pg_cron at 23:30 Asia/Manila with the x-backup-secret header, or by an owner
// from the Reports page (their own business only). For each business it exports that day's
// orders, order items, payments, refunds, voids, shifts, drawer movements and audit log as CSV
// to the private "backups" bucket at YYYY/MM/DD/<business_id>/<file>.csv, records the run in
// backup_runs, deletes backups past the retention period, and emails a summary only if an
// email provider key is configured (RESEND_API_KEY and BACKUP_EMAIL_TO).
//
// Rows are chosen by server time (when they reached the server), so an order that syncs a day
// late is still backed up exactly once.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { manilaDayWindow, manilaToday } from "./csv.ts";
import { buildBackupFiles, isExpired, type BackupData, type BackupFile } from "./files.ts";

const BUCKET = "backups";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-backup-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const body = (await req.json().catch(() => ({}))) as { date?: string; trigger?: string };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "") ? body.date! : manilaToday();

  // Who is asking: the cron secret (all businesses) or a signed-in owner (their business).
  let businessIds: string[];
  let trigger: "cron" | "manual" = "cron";
  if (await cronSecretOk(admin, req.headers.get("x-backup-secret"))) {
    const { data, error } = await admin.from("businesses").select("id");
    if (error) return json({ error: error.message }, 500);
    businessIds = (data ?? []).map((b: { id: string }) => b.id);
    trigger = body.trigger === "manual" ? "manual" : "cron";
  } else {
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "not authorised" }, 401);
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "not authorised" }, 401);
    const { data: m } = await admin.from("memberships").select("business_id").eq("user_id", user.id).eq("role", "owner");
    businessIds = (m ?? []).map((r: { business_id: string }) => r.business_id);
    if (businessIds.length === 0) return json({ error: "owners only" }, 403);
    trigger = "manual";
  }

  const results = [];
  for (const businessId of businessIds) results.push(await backupBusiness(admin, businessId, date, trigger));
  return json({ date, results }, results.every((r) => r.status === "success") ? 200 : 500);
});

// The cron's secret: BACKUP_CRON_SECRET if set on the function, otherwise the Vault secret
// the cron job itself reads (checked in the database, so it never leaves Vault).
async function cronSecretOk(admin: SupabaseClient, given: string | null): Promise<boolean> {
  if (!given) return false;
  const env = Deno.env.get("BACKUP_CRON_SECRET");
  if (env) return given === env;
  const { data, error } = await admin.rpc("backup_secret_matches", { p_secret: given });
  return !error && data === true;
}

async function backupBusiness(admin: SupabaseClient, businessId: string, date: string, trigger: "cron" | "manual") {
  const { data: run } = await admin.from("backup_runs")
    .insert({ business_id: businessId, backup_date: date, trigger, status: "running" }).select("id").single();
  const runId = (run as { id: string } | null)?.id;
  try {
    const data = await fetchDay(admin, businessId, date);
    const files = buildBackupFiles(data);
    const [y, m, d] = date.split("-");
    const paths: string[] = [];
    for (const f of files) {
      const path = `${y}/${m}/${d}/${businessId}/${f.name}`;
      const { error } = await admin.storage.from(BUCKET).upload(path, new Blob([f.csv], { type: "text/csv;charset=utf-8" }), {
        contentType: "text/csv; charset=utf-8", upsert: true,
      });
      if (error) throw new Error(`${f.name}: ${error.message}`);
      paths.push(path);
    }
    const { data: biz } = await admin.from("businesses").select("name, backup_retention_days").eq("id", businessId).single();
    const retention = (biz as { backup_retention_days: number } | null)?.backup_retention_days ?? 365;
    const deleted = await deleteExpired(admin, businessId, manilaToday(), retention);
    const emailed = await emailSummary((biz as { name: string } | null)?.name ?? "Crumb Club", date, files);
    const rowCounts = Object.fromEntries(files.map((f) => [f.name.replace(/\.csv$/, ""), f.rows]));
    await admin.from("backup_runs").update({
      status: "success", finished_at: new Date().toISOString(), row_counts: rowCounts, files: paths, deleted_files: deleted, emailed,
    }).eq("id", runId);
    return { businessId, status: "success", rowCounts, deleted, emailed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.from("backup_runs").update({ status: "failed", finished_at: new Date().toISOString(), error: message }).eq("id", runId);
    return { businessId, status: "failed", error: message };
  }
}

async function fetchDay(admin: SupabaseClient, businessId: string, date: string): Promise<BackupData> {
  const { from, to } = manilaDayWindow(date);
  const all = async <T,>(build: (lo: number, hi: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> => {
    const out: T[] = [];
    for (let lo = 0; ; lo += 1000) {
      const { data, error } = await build(lo, lo + 999);
      if (error) throw new Error(error.message);
      const rows = (data as T[]) ?? [];
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  };
  const ORDER_SELECT = "*, events(name), staff:staff!transactions_staff_id_fkey(name), voided_by:staff!transactions_voided_by_staff_id_fkey(name), device:pos_devices(device_code)";
  const orders = await all<BackupData["orders"][number]>((lo, hi) => admin.from("transactions").select(ORDER_SELECT)
    .eq("business_id", businessId).gte("created_at", from).lt("created_at", to).order("created_at").range(lo, hi));
  const lines: BackupData["lines"] = [];
  for (let i = 0; i < orders.length; i += 200) {
    const ids = orders.slice(i, i + 200).map((o) => o.id);
    const { data, error } = await admin.from("transaction_lines")
      .select("id, transaction_id, position, kind, name_snapshot, quantity, unit_price_centavos, line_total_centavos")
      .in("transaction_id", ids).order("position");
    if (error) throw new Error(error.message);
    lines.push(...((data as BackupData["lines"]) ?? []));
  }
  const voids = await all<BackupData["voids"][number]>((lo, hi) => admin.from("transactions").select(ORDER_SELECT)
    .eq("business_id", businessId).eq("status", "voided").gte("voided_at", from).lt("voided_at", to).order("voided_at").range(lo, hi));
  const refunds = await all<BackupData["refunds"][number]>((lo, hi) => admin.from("refunds")
    .select("*, staff:staff!refunds_staff_id_fkey(name), approver:staff!refunds_approved_by_staff_id_fkey(name), order:transactions(order_number), refund_lines(transaction_line_id, quantity, amount_centavos)")
    .eq("business_id", businessId).gte("created_at", from).lt("created_at", to).order("created_at").range(lo, hi));
  const shifts = await all<BackupData["shifts"][number]>((lo, hi) => admin.from("shifts")
    .select("*, device:pos_devices(device_code), opener:staff!shifts_opened_by_staff_id_fkey(name), closer:staff!shifts_closed_by_staff_id_fkey(name), approver:staff!shifts_variance_approved_by_staff_id_fkey(name), events(name)")
    .eq("business_id", businessId).or(`and(created_at.gte.${from},created_at.lt.${to}),and(closed_synced_at.gte.${from},closed_synced_at.lt.${to})`)
    .order("opened_at").range(lo, hi));
  const drawer = await all<BackupData["drawer"][number]>((lo, hi) => admin.from("drawer_movements")
    .select("*, staff:staff!drawer_movements_staff_id_fkey(name), approver:staff!drawer_movements_approved_by_staff_id_fkey(name)")
    .eq("business_id", businessId).gte("created_at", from).lt("created_at", to).order("created_at").range(lo, hi));
  const audit = await all<BackupData["audit"][number]>((lo, hi) => admin.from("audit_log")
    .select("*, cashier:staff!audit_log_cashier_staff_id_fkey(name), manager:staff!audit_log_manager_staff_id_fkey(name), device:pos_devices(device_code)")
    .eq("business_id", businessId).gte("server_time", from).lt("server_time", to).order("server_time").range(lo, hi));
  return { orders, lines, voids, refunds, shifts, drawer, audit };
}

/** Removes this business's backup folders older than the retention period. */
async function deleteExpired(admin: SupabaseClient, businessId: string, today: string, retentionDays: number): Promise<number> {
  const store = admin.storage.from(BUCKET);
  const folders = async (prefix: string) => ((await store.list(prefix, { limit: 1000 })).data ?? []).filter((e) => e.id === null).map((e) => e.name);
  let deleted = 0;
  for (const y of await folders("")) {
    for (const m of await folders(y)) {
      for (const d of await folders(`${y}/${m}`)) {
        if (!isExpired(`${y}-${m}-${d}`, today, retentionDays)) continue;
        const dir = `${y}/${m}/${d}/${businessId}`;
        const { data: files } = await store.list(dir, { limit: 1000 });
        const paths = (files ?? []).filter((f) => f.id !== null).map((f) => `${dir}/${f.name}`);
        if (paths.length > 0) {
          const { error } = await store.remove(paths);
          if (!error) deleted += paths.length;
        }
      }
    }
  }
  return deleted;
}

/** Emails a summary with orders.csv attached, only when an email provider is configured. */
async function emailSummary(businessName: string, date: string, files: BackupFile[]): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  const to = Deno.env.get("BACKUP_EMAIL_TO");
  const from = Deno.env.get("BACKUP_EMAIL_FROM") ?? Deno.env.get("INVITE_EMAIL_FROM");
  if (!key || !to || !from) return false;
  const orders = files.find((f) => f.name === "orders.csv")!;
  const lines = files.map((f) => `<li>${f.name}: ${f.rows} row${f.rows === 1 ? "" : "s"}</li>`).join("");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: to.split(",").map((s) => s.trim()),
      subject: `${businessName} backup for ${date}`,
      html: `<p>The nightly backup for ${date} finished.</p><ul>${lines}</ul><p>All files are in Supabase Storage, bucket "backups".</p>`,
      attachments: [{ filename: `orders-${date}.csv`, content: btoa(unescape(encodeURIComponent(orders.csv))) }],
    }),
  });
  return res.ok;
}
