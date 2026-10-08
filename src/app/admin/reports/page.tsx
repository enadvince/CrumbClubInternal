"use client";
import { PageHeader } from "@/components/ui";
import { LowStock } from "./LowStock";
import { ShiftReports } from "./ShiftReports";

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Reports" subtitle="Low stock, shift reports, backups and exports." />
      <div className="space-y-6">
        <section className="card space-y-3 p-5" aria-labelledby="low-h">
          <h2 id="low-h" className="text-lg font-bold">Low stock</h2>
          <LowStock />
        </section>
        <section className="card space-y-3 p-5" aria-labelledby="shifts-h">
          <h2 id="shifts-h" className="text-lg font-bold">Shift reports</h2>
          <ShiftReports />
        </section>
      </div>
    </>
  );
}
