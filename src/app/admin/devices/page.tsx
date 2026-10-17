"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { ConfirmModal } from "@/components/ConfirmModal";
import { errorMessage } from "@/lib/errors";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import { formatDateTime, timeAgo } from "@/lib/time";
import { isTabletOwnerView } from "@/lib/ownerView";
import { getDb, KV, type DeviceInfo } from "@/lib/offline/db";

type Device = {
  id: string;
  device_user_id: string | null;
  device_code: string;
  label: string | null;
  registered_at: string;
  last_seen_at: string | null;
};
type Heartbeat = { device_user_id: string; last_seen_at: string; unsynced_count: number; oldest_unsynced_at: string | null; app_version: string | null };
type Row = Device & { heartbeat: Heartbeat | null; seen: string | null };

/** Paired POS tablets: when each last checked in and what it still holds. Owners can rename or remove them. */
export default function DevicesPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  // Owner view on a tablet: that tablet can't remove itself from here.
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);

  useEffect(() => {
    isTabletOwnerView()
      .then(async (onTablet) => onTablet && setThisDeviceId((await getDb().getKv<DeviceInfo>(KV.device))?.deviceId ?? null))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    const supabase = getSupabase();
    const [devices, heartbeats] = await Promise.all([
      supabase.from("pos_devices").select("id, device_user_id, device_code, label, registered_at, last_seen_at").is("removed_at", null),
      supabase.from("device_heartbeats").select("device_user_id, last_seen_at, unsynced_count, oldest_unsynced_at, app_version"),
    ]);
    if (devices.error || heartbeats.error) return setError(errorMessage(devices.error ?? heartbeats.error));
    setError(null);
    const byUser = new Map((heartbeats.data as Heartbeat[]).map((h) => [h.device_user_id, h]));
    const list = (devices.data as Device[]).map((d) => {
      const heartbeat = d.device_user_id ? byUser.get(d.device_user_id) ?? null : null;
      const seen = [d.last_seen_at, heartbeat?.last_seen_at].filter((t): t is string => !!t).sort().at(-1) ?? null;
      return { ...d, heartbeat, seen };
    });
    // Most recently active first; never-seen tablets last, by code.
    list.sort((a, b) => (b.seen ?? "").localeCompare(a.seen ?? "") || codeNumber(a) - codeNumber(b));
    setRows(list);
  }, []);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, { paused: !!renaming || !!removing });

  async function remove(row: Row) {
    setMessage(null);
    const res = await fetch("/api/devices/remove", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: row.id }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    setRemoving(null);
    if (!res?.ok) setError(body?.error ?? "Could not remove the tablet. Check your connection.");
    else setMessage(`${row.device_code} removed. It is signed out and needs an owner login to be set up again.`);
    await load();
  }

  return (
    <>
      <PageHeader
        title="Tablets"
        subtitle="POS tablets paired to this business. Each tablet's code starts its order numbers."
        actions={<Link href="/pos/pair" className="btn-secondary">Set up POS tablet</Link>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {message && <Notice tone="ok" className="mb-4">{message}</Notice>}
      {!rows ? <Spinner /> : rows.length === 0 ? <EmptyState>No tablets paired yet.</EmptyState> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" aria-label="Paired tablets">
            <thead className="bg-cream text-left text-ink-soft">
              <tr>
                <th className="p-3 font-semibold">Code</th>
                <th className="p-3 font-semibold">Name</th>
                <th className="p-3 font-semibold">Last seen</th>
                <th className="p-3 font-semibold">Not synced</th>
                <th className="p-3 font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-crust-dark">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="p-3 font-mono font-bold">{r.device_code}</td>
                  <td className="p-3">
                    {r.label ?? <span className="text-ink-soft">No name</span>}
                    {r.id === thisDeviceId && <span className="badge ml-2 bg-ube-light text-ube">This tablet</span>}
                  </td>
                  <td className="p-3 whitespace-nowrap" title={r.seen ? formatDateTime(r.seen) : undefined}>
                    {r.seen ? timeAgo(r.seen) : <span className="text-ink-soft">Never</span>}
                    {r.heartbeat?.app_version && <span className="block text-xs text-ink-soft">App {r.heartbeat.app_version}</span>}
                  </td>
                  <td className="p-3">
                    {r.heartbeat?.unsynced_count
                      ? <span className="font-semibold text-danger">{r.heartbeat.unsynced_count} item(s)</span>
                      : <span className="text-ink-soft">{r.heartbeat ? "None" : "—"}</span>}
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-2">
                      <button className="btn-secondary min-h-11 text-sm" onClick={() => setRenaming(r)}>Rename</button>
                      <button className="btn-ghost min-h-11 text-sm text-danger" onClick={() => setRemoving(r)}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-sm text-ink-soft">“Not synced” is what the tablet last reported. A tablet reports in while the POS is open and online.</p>

      <RenameModal row={renaming} onClose={() => setRenaming(null)} onSaved={async () => { setRenaming(null); await load(); }} />
      <ConfirmModal
        open={!!removing}
        title={`Remove ${removing?.device_code ?? ""}${removing?.label ? ` (${removing.label})` : ""}?`}
        confirmLabel="Remove and sign out"
        onClose={() => setRemoving(null)}
        onConfirm={() => remove(removing!)}
        blockedReason={removing && removing.id === thisDeviceId
          ? "This is the tablet you're using. To reset it, go back to the POS and use Owner Menu → Tablet → Unpair."
          : undefined}
      >
        <p>The tablet is signed out and can no longer ring up sales or sync. Its past orders stay. Setting it up again needs an owner login and gives it a new code.</p>
        {!!removing?.heartbeat?.unsynced_count && (
          <Notice tone="danger" className="mt-3">
            It last reported {removing.heartbeat.unsynced_count} item(s) not synced
            {removing.heartbeat.oldest_unsynced_at ? ` since ${formatDateTime(removing.heartbeat.oldest_unsynced_at)}` : ""}.
            Those will never reach the owner pages. Sync the tablet first, or download its emergency export (Owner Menu → Sync &amp; backup).
          </Notice>
        )}
      </ConfirmModal>
    </>
  );
}

function codeNumber(d: Device) {
  return Number(d.device_code.slice(1)) || 0;
}

function RenameModal({ row, onClose, onSaved }: { row: Row | null; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (row) { setLabel(row.label ?? ""); setError(null); } }, [row]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { error } = await getSupabase().rpc("rename_device", { p_device_id: row!.id, p_label: label });
    setSaving(false);
    if (error) return setError(errorMessage(error));
    onSaved();
  }

  return (
    <Modal open={!!row} onClose={onClose} title={`Rename ${row?.device_code ?? ""}`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Name" htmlFor="device-label" hint="Shown in the PIN log and on this page.">
          <input id="device-label" autoFocus required maxLength={60} className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </Modal>
  );
}
