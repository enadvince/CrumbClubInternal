"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { Notice } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { formatPeso } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { SkeletonRows } from "./LowStock";

type ShiftRow = {
  id: string; status: "open" | "closed"; opened_at: string; closed_at: string | null; opening_float_centavos: number;
  counted_cash_centavos: number | null; variance_centavos: number | null; close_note: string | null;
  device: { device_code: string } | null; opener: { name: string } | null; events: { name: string } | null;
};

/** Recent shifts from every tablet. Each opens a printable report built from server data. */
export function ShiftReports() {
  const [rows, setRows] = useState<ShiftRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getSupabase().from("shifts")
      .select("id, status, opened_at, closed_at, opening_float_centavos, counted_cash_centavos, variance_centavos, close_note, device:pos_devices(device_code), opener:staff!shifts_opened_by_staff_id_fkey(name), events(name)")
      .order("opened_at", { ascending: false }).limit(50)
      .then(({ data, error }) => (error ? setError(errorMessage(error)) : setRows((data as unknown as ShiftRow[]) ?? [])));
  }, []);
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!rows) return <SkeletonRows rows={4} />;
  if (rows.length === 0) return <p className="text-ink-soft">No shifts yet. Tablets open a shift before their first sale.</p>;
  return (
    <ul className="divide-y divide-crust-dark rounded-xl border border-crust-dark">
      {rows.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-3 p-3">
          <span className="min-w-48 flex-1">
            <span className="font-semibold">{formatDateTime(s.opened_at)}</span>
            <span className="block text-xs text-ink-soft">
              {s.device?.device_code ?? "?"} · {s.opener?.name ?? ""} · {s.events?.name ?? ""}{s.closed_at ? ` · closed ${formatDateTime(s.closed_at)}` : " · open"}
            </span>
          </span>
          {s.variance_centavos != null && (
            <span className={`badge ${s.variance_centavos === 0 ? "bg-ok-light text-ok" : "bg-warn-light text-warn"}`}>Variance {formatPeso(s.variance_centavos, { sign: true })}</span>
          )}
          {s.close_note && <span className="badge bg-mute-light text-mute">Auto-closed</span>}
          <Link className="btn-secondary min-h-11 text-sm" href={`/admin/reports/shift/${s.id}`}>View report</Link>
        </li>
      ))}
    </ul>
  );
}
