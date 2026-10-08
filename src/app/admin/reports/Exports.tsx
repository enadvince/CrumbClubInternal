"use client";
import { useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { Field, Notice } from "@/components/ui";
import { downloadText } from "@/lib/csv";
import { exportFiles, fetchExportData } from "@/lib/exports";
import { errorMessage } from "@/lib/errors";
import { addDays, manilaDate } from "@/lib/time";
import { uuidv7 } from "@/lib/uuid";

const FILES = [
  { name: "orders.csv", label: "Orders" },
  { name: "order_items.csv", label: "Order items" },
  { name: "payments.csv", label: "Payments" },
  { name: "shifts.csv", label: "Shifts" },
  { name: "drawer_movements.csv", label: "Drawer movements" },
  { name: "refunds.csv", label: "Refunds" },
  { name: "voids.csv", label: "Voids" },
  { name: "audit_log.csv", label: "Audit log" },
];

/** Manual export for a date range: the same CSV files as the nightly backup, plus a printable summary. */
export function Exports() {
  const today = manilaDate();
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(names: string[]) {
    setBusy(names.length > 1 ? "all" : names[0]);
    setError(null);
    try {
      const supabase = getSupabase();
      const files = exportFiles(await fetchExportData(supabase, { from, to })).filter((f) => names.includes(f.name));
      for (const f of files) downloadText(`crumbclub-${from}-to-${to}-${f.name}`, f.csv);
      await supabase.rpc("log_audit", { p_entry: { id: uuidv7(), action: "export", note: `${from} to ${to}: ${names.join(", ")}` } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="grid max-w-md grid-cols-2 gap-3">
        <Field label="From" htmlFor="x-from"><input id="x-from" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To" htmlFor="x-to"><input id="x-to" type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <p className="text-sm text-ink-soft">By sale date (Asia/Manila). CSV files open in Excel: UTF-8, ISO dates, amounts as plain numbers.</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" onClick={() => download(FILES.map((f) => f.name))} disabled={!!busy}>{busy === "all" ? "Preparing..." : "⬇ Download all CSVs"}</button>
        {FILES.map((f) => (
          <button key={f.name} className="btn-secondary min-h-11 text-sm" onClick={() => download([f.name])} disabled={!!busy}>
            {busy === f.name ? "Preparing..." : `⬇ ${f.label}`}
          </button>
        ))}
        <Link className="btn-secondary min-h-11 text-sm" href={`/admin/reports/summary?from=${from}&to=${to}`}>🖨 Summary (print or save as PDF)</Link>
      </div>
    </div>
  );
}
