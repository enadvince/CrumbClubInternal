"use client";
import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { Notice, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/errors";

type LowStockItem = { event_product_id: string; name: string; category: string; stock: number; threshold: number; out: boolean };
type LowStockReport = { event: { id: string; name: string; status: string } | null; items: LowStockItem[] };

/** Tracked products at or below their low stock threshold for the live event. */
export function LowStock() {
  const [report, setReport] = useState<LowStockReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getSupabase().rpc("low_stock_report", {}).then(({ data, error }) => {
      if (error) setError(errorMessage(error));
      else setReport(data as LowStockReport);
    });
  }, []);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!report) return <SkeletonRows rows={3} />;
  if (!report.event) return <p className="text-ink-soft">No event is live, so there is no stock to watch.</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-soft">{report.event.name}. Counts include every synced sale, refund and stock change.</p>
      {report.items.length === 0 ? (
        <Notice tone="ok">Nothing is low. Every tracked product is above its alert level.</Notice>
      ) : (
        <ul className="divide-y divide-crust-dark rounded-xl border border-crust-dark">
          {report.items.map((i) => (
            <li key={i.event_product_id} className="flex flex-wrap items-center gap-3 p-3">
              <span className="min-w-40 flex-1 font-semibold">{i.name}<span className="ml-2 text-xs font-normal text-ink-soft">{i.category}</span></span>
              <span className={`badge ${i.out ? "bg-danger text-white" : "bg-warn-light text-warn"}`}>
                {i.out ? "✕ Out of stock" : `⚠ Low: ${i.stock} left`}
              </span>
              <span className="w-28 text-right text-sm text-ink-soft">alert at {i.threshold}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Placeholder rows while data loads (pulses only when motion is allowed). */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-12 rounded-xl bg-crust motion-safe:animate-pulse" />
      ))}
    </div>
  );
}
