"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { Notice, Spinner } from "@/components/ui";
import { fetchExportData, summarize } from "@/lib/exports";
import { formatPeso } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/time";
import { errorMessage } from "@/lib/errors";
import { useOwner } from "../../OwnerContext";
import { ReportsGate } from "../ReportsGate";

/** Printable A4 summary for a date range. "Save as PDF" in the print dialog makes the PDF (no PDF library). */
export default function SummaryPage() {
  return (
    <ReportsGate>
      <Suspense fallback={<Spinner />}><Summary /></Suspense>
    </ReportsGate>
  );
}

function Summary() {
  const params = useSearchParams();
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const { businessName } = useOwner();
  const [s, setS] = useState<ReturnType<typeof summarize> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!from || !to) return;
    fetchExportData(getSupabase(), { from, to }).then((d) => setS(summarize(d))).catch((e) => setError(errorMessage(e)));
  }, [from, to]);
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!s) return <Spinner label="Building the summary" />;
  const row = (label: string, value: string, strong = false, key?: string) => (
    <tr key={key ?? label} className={strong ? "font-bold" : ""}><td className="py-1.5 pr-3">{label}</td><td className="py-1.5 text-right tabular-nums">{value}</td></tr>
  );
  return (
    <article className="print-page mx-auto max-w-3xl space-y-5">
      <div className="no-print flex gap-2">
        <Link href="/admin/reports" className="btn-ghost">← Reports</Link>
        <button className="btn-primary" onClick={() => window.print()}>🖨 Print or save as PDF</button>
      </div>
      <header>
        <h1 className="text-2xl font-bold">{businessName}: sales summary</h1>
        <p className="text-ink-soft">{formatDate(from)} to {formatDate(to)} (Asia/Manila) · printed {formatDateTime(Date.now())}</p>
      </header>
      <section>
        <h2 className="mb-2 font-bold">Sales</h2>
        <table className="w-full text-sm"><tbody className="divide-y divide-crust-dark">
          {row("Orders", String(s.orders))}
          {row("Gross sales", formatPeso(s.gross))}
          {row("Discounts", formatPeso(-s.discounts))}
          {row(`Voids (${s.voids.count})`, formatPeso(s.voids.total))}
          {row(`Refunds (${s.refunds.count})`, formatPeso(-s.refunds.total))}
          {row("Net sales", formatPeso(s.net), true)}
          {row("Cash", formatPeso(s.cash))}
          {row("QR", formatPeso(s.qr))}
          {row("QR payments awaiting verification", String(s.qrAwaiting))}
        </tbody></table>
      </section>
      <section>
        <h2 className="mb-2 font-bold">Shifts</h2>
        {s.shifts.length === 0 ? <p className="text-sm text-ink-soft">No shifts.</p> : (
          <table className="w-full text-sm"><tbody className="divide-y divide-crust-dark">
            {s.shifts.map((sh) => row(
              `${sh.device?.device_code ?? ""} ${formatDateTime(sh.opened_at)} (${sh.opener?.name ?? ""})`,
              sh.variance_centavos == null ? "open" : `variance ${formatPeso(sh.variance_centavos, { sign: true })}`,
              false, sh.id,
            ))}
          </tbody></table>
        )}
      </section>
      <section>
        <h2 className="mb-2 font-bold">Top items</h2>
        <table className="w-full text-sm"><tbody className="divide-y divide-crust-dark">
          {s.topItems.map((i) => row(`${i.quantity}× ${i.name}`, formatPeso(i.revenue)))}
        </tbody></table>
      </section>
    </article>
  );
}
