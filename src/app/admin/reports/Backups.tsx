"use client";
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { Notice } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { formatDate, formatDateTime, timeAgo } from "@/lib/time";
import { SkeletonRows } from "./LowStock";

type Run = {
  id: string; backup_date: string; trigger: string; status: "running" | "success" | "failed"; started_at: string; finished_at: string | null;
  row_counts: Record<string, number> | null; deleted_files: number | null; emailed: boolean | null; error: string | null;
};
type Status = { last_success_at: string | null; stale: boolean; retention_days: number; recent: Run[] };

/** Nightly backups: last success, a warning after 48 hours without one, recent runs, and a manual run. */
export function Backups() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => {
    getSupabase().rpc("backup_status").then(({ data, error }) => (error ? setError(errorMessage(error)) : setStatus(data as Status)));
  }, []);
  useEffect(load, [load]);

  async function runNow() {
    setRunning(true);
    setMessage(null);
    const { error } = await getSupabase().functions.invoke("daily-backup", { body: { trigger: "manual" } });
    setRunning(false);
    setMessage(error ? `Backup failed: ${errorMessage(error)}` : "Backup finished. Today's files are in Storage.");
    load();
  }

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!status) return <SkeletonRows rows={2} />;
  return (
    <div className="space-y-3">
      {status.stale ? (
        <Notice tone="danger">
          No successful backup in the last 48 hours{status.last_success_at ? ` (last one ${timeAgo(status.last_success_at)})` : ""}.
          Run one now, and check the daily-backup function in Supabase.
        </Notice>
      ) : (
        <Notice tone="ok">Last successful backup: {formatDateTime(status.last_success_at!)} ({timeAgo(status.last_success_at!)}).</Notice>
      )}
      <p className="text-sm text-ink-soft">
        Every night at 23:30 the day&apos;s orders, items, payments, refunds, voids, shifts, drawer movements and audit log are saved as CSV
        files in the private &quot;backups&quot; storage bucket. Backups older than {status.retention_days} days are deleted.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secondary" onClick={runNow} disabled={running}>{running ? "Backing up..." : "Run backup now"}</button>
        {message && <span role="status" className="text-sm font-semibold">{message}</span>}
      </div>
      {status.recent.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-ink-soft"><tr><th className="p-2">Day</th><th className="p-2">Ran</th><th className="p-2">Result</th><th className="p-2">Rows</th></tr></thead>
            <tbody className="divide-y divide-crust-dark">
              {status.recent.map((r) => (
                <tr key={r.id}>
                  <td className="p-2">{formatDate(r.backup_date)}</td>
                  <td className="p-2">{formatDateTime(r.started_at)} <span className="text-ink-soft">({r.trigger})</span></td>
                  <td className="p-2">
                    <span className={`badge ${r.status === "success" ? "bg-ok-light text-ok" : r.status === "failed" ? "bg-danger-light text-danger" : "bg-mute-light text-mute"}`}>{r.status}</span>
                    {r.error && <span className="block text-xs text-danger">{r.error}</span>}
                  </td>
                  <td className="p-2 text-xs">{r.row_counts ? Object.entries(r.row_counts).map(([k, v]) => `${k} ${v}`).join(", ") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
