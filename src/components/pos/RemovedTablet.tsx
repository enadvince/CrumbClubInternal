"use client";
import { useState } from "react";
import { ConfirmModal } from "@/components/ConfirmModal";
import { Logo } from "@/components/ui";
import { backupCsv, backupJson } from "@/lib/offline/backup";
import { downloadText } from "@/lib/csv";
import type { PosDatabase } from "@/lib/offline/db";

/**
 * Shown once an owner removed this tablet on the Tablets page. Nothing can sync any
 * more, so anything still on the tablet can only leave it through the emergency export.
 */
export function RemovedTablet({ db, unsynced, onReset }: { db: PosDatabase; unsynced: number; onReset: () => Promise<void> }) {
  const [exported, setExported] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function download(kind: "json" | "csv") {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    if (kind === "json") downloadText(`crumbclub-emergency-export-${stamp}.json`, await backupJson(db), "application/json");
    else downloadText(`crumbclub-emergency-export-${stamp}.csv`, await backupCsv(db));
    setExported(true);
  }

  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo className="text-3xl text-caramel" />
      <h1 className="text-2xl font-bold">This tablet was removed</h1>
      <p className="max-w-md text-ink-soft">An owner removed it on the Tablets page, so it can no longer ring up sales or sync.</p>
      {unsynced > 0 && (
        <div className="max-w-md rounded-xl bg-danger-light p-3 font-semibold text-danger">
          {unsynced} item(s) on this tablet never reached the server. Download the emergency export and give it to an owner before resetting.
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <button className="btn-secondary" onClick={() => download("json")}>⬇ Export (JSON)</button>
            <button className="btn-secondary" onClick={() => download("csv")}>⬇ Export (CSV)</button>
          </div>
        </div>
      )}
      <button className="btn-primary" onClick={() => setConfirm(true)}>Reset and set up again</button>
      <ConfirmModal
        open={confirm}
        title="Reset this tablet?"
        confirmLabel="Reset"
        onClose={() => setConfirm(false)}
        onConfirm={onReset}
      >
        <p>This deletes everything stored on the tablet. Setting it up again needs an owner login.</p>
        {unsynced > 0 && !exported && <p className="mt-2 font-semibold text-danger">You haven&apos;t downloaded the emergency export yet. {unsynced} item(s) will be lost.</p>}
      </ConfirmModal>
    </main>
  );
}
