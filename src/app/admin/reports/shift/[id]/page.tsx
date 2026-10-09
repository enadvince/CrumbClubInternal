"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { Notice, Spinner } from "@/components/ui";
import { ShiftReportView } from "@/components/pos/Shift";
import { fromServerShiftReport, type ServerShiftReport, type ShiftReport } from "@/lib/pos/shift";
import { errorMessage } from "@/lib/errors";
import { useOwner } from "../../../OwnerContext";

/** A shift report from server data, printable on A4. */
export default function ShiftReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { businessName } = useOwner();
  const [report, setReport] = useState<{ view: ShiftReport; device: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getSupabase().rpc("shift_report", { p_shift_id: id }).then(({ data, error }) => {
      if (error) return setError(errorMessage(error));
      const raw = data as ServerShiftReport;
      setReport({ view: fromServerShiftReport(raw), device: raw.shift.device_code });
    });
  }, [id]);
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!report) return <Spinner />;
  return (
    <>
      <Link href="/admin/reports" className="no-print btn-ghost mb-2">← Reports</Link>
      <ShiftReportView report={report.view} businessName={businessName} deviceCode={report.device ?? undefined} />
    </>
  );
}
