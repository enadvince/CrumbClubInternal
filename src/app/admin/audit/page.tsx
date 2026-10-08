"use client";
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { CopyButton } from "@/components/CopyButton";
import { BackToTop, ScrollProgress } from "@/components/ScrollAids";
import { errorMessage } from "@/lib/errors";
import { formatPeso } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { AUDIT_ACTION_LABEL, AUDIT_SELECT, type AuditRow } from "@/lib/audit";

const PAGE = 100;

/** Every void, refund, cash movement and owner PIN override. Read-only. */
export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [count, setCount] = useState(0);
  const [action, setAction] = useState("");
  const [order, setOrder] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (offset: number) => {
    let q = getSupabase().from("audit_log").select(AUDIT_SELECT, { count: "exact" }).order("server_time", { ascending: false });
    if (action) q = q.eq("action", action);
    if (order.trim()) q = q.ilike("order_number", `%${order.trim().replace(/[%_]/g, "")}%`);
    const { data, error, count } = await q.range(offset, offset + PAGE - 1);
    if (error) return setError(errorMessage(error));
    setError(null);
    setCount(count ?? 0);
    setRows((prev) => (offset === 0 ? (data as unknown as AuditRow[]) : [...(prev ?? []), ...(data as unknown as AuditRow[])]));
  }, [action, order]);

  useEffect(() => {
    setRows(null);
    const t = setTimeout(() => load(0), 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <>
      <ScrollProgress />
      <BackToTop />
      <PageHeader title="Audit log" subtitle="Voids, refunds, cash movements and owner PIN approvals, from every tablet. Entries can't be edited or deleted." />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label="Action" htmlFor="a-action">
          <select id="a-action" className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            {Object.entries(AUDIT_ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Order number" htmlFor="a-order">
          <input id="a-order" className="input" value={order} onChange={(e) => setOrder(e.target.value)} placeholder="e.g. T1-261008" />
        </Field>
      </div>
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {!rows ? <Spinner /> : rows.length === 0 ? <EmptyState>Nothing in the audit log yet.</EmptyState> : (
        <>
          <p className="mb-2 text-sm text-ink-soft">{count} entr{count === 1 ? "y" : "ies"}</p>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-cream text-left text-ink-soft">
                <tr>
                  <th className="p-3 font-semibold">Server time</th>
                  <th className="p-3 font-semibold">Action</th>
                  <th className="p-3 font-semibold">Order</th>
                  <th className="p-3 text-right font-semibold">Amount</th>
                  <th className="p-3 font-semibold">Reason</th>
                  <th className="p-3 font-semibold">Cashier</th>
                  <th className="p-3 font-semibold">Approved by</th>
                  <th className="p-3 font-semibold">Tablet</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-crust-dark">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="p-3 whitespace-nowrap">
                      {formatDateTime(r.server_time)}
                      {r.device_time && Math.abs(Date.parse(r.device_time) - Date.parse(r.server_time)) > 5 * 60_000 && (
                        <span className="block text-xs text-ink-soft">tablet: {formatDateTime(r.device_time)}</span>
                      )}
                    </td>
                    <td className="p-3 font-semibold">{AUDIT_ACTION_LABEL[r.action] ?? r.action}</td>
                    <td className="p-3 whitespace-nowrap">{r.order_number ? <span className="inline-flex items-center gap-1 font-mono">{r.order_number}<CopyButton value={r.order_number} /></span> : ""}</td>
                    <td className="p-3 text-right tabular-nums">{r.amount_centavos != null ? formatPeso(r.amount_centavos) : ""}</td>
                    <td className="p-3">{[r.reason, r.note].filter(Boolean).join(": ")}</td>
                    <td className="p-3">{r.cashier?.name ?? ""}</td>
                    <td className="p-3">{r.manager?.name ?? ""}</td>
                    <td className="p-3">{r.device ? r.device.device_code : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length < count && <button className="btn-secondary mt-4 w-full" onClick={() => load(rows.length)}>Load more ({count - rows.length} more)</button>}
        </>
      )}
    </>
  );
}
