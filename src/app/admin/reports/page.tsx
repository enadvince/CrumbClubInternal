"use client";
import { PageHeader } from "@/components/ui";
import { ScrollProgress, BackToTop } from "@/components/ScrollAids";
import { LowStock } from "./LowStock";
import { ShiftReports } from "./ShiftReports";
import { ReportsGate } from "./ReportsGate";
import { Backups } from "./Backups";
import { Exports } from "./Exports";
import { Settings } from "./Settings";

export default function ReportsPage() {
  return (
    <>
      <ScrollProgress />
      <PageHeader title="Reports" subtitle="Low stock, shift reports, backups and exports." />
      <ReportsGate>
        <div className="space-y-6">
          <section className="card space-y-3 p-5" aria-labelledby="low-h">
            <h2 id="low-h" className="text-lg font-bold">Low stock</h2>
            <LowStock />
          </section>
          <section className="card space-y-3 p-5" aria-labelledby="shifts-h">
            <h2 id="shifts-h" className="text-lg font-bold">Shift reports</h2>
            <ShiftReports />
          </section>
          <section className="card space-y-3 p-5" aria-labelledby="export-h">
            <h2 id="export-h" className="text-lg font-bold">Export</h2>
            <Exports />
          </section>
          <section className="card space-y-3 p-5" aria-labelledby="backup-h">
            <h2 id="backup-h" className="text-lg font-bold">Backups</h2>
            <Backups />
          </section>
          <section className="card space-y-3 p-5" aria-labelledby="settings-h">
            <h2 id="settings-h" className="text-lg font-bold">Settings</h2>
            <Settings />
          </section>
        </div>
      </ReportsGate>
      <BackToTop />
    </>
  );
}
