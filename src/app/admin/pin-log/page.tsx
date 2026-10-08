"use client";
import { useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/time";

const PAGE = 100;

type PinUse = {
  id: string;
  staff_id: string | null;
  staff_name: string;
  staff_role: "owner" | "staff";
  action: "sign_in" | "owner_menu" | "owner_view" | "void_approval" | "co_owner_login";
  used_at: string;
  device_label: string | null;
};
type Option = { id: string; name: string };

const PIN_ACTION_LABEL: Record<PinUse["action"], string> = {
  sign_in: "Signed in to the POS",
  owner_menu: "Opened the owner menu",
  owner_view: "Opened owner view on the tablet",
  void_approval: "Approved a void",
  co_owner_login: "Signed in to the owner pages (co-owner)",
};

/** Every time a PIN was used, by owners and staff. Read-only: the log can't be edited or deleted. */
export default function PinLogPage() {
  const [rows, setRows] = useState<PinUse[] | null>(null);
  const [count, setCount] = useState(0);
  const [staff, setStaff] = useState<Option[]>([]);
  const [staffId, setStaffId] = useState("");
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSupabase().from("staff").select("id, name").order("name").then(({ data }) => setStaff((data as Option[]) ?? []));
  }, []);

  const load = useCallback(async (offset: number) => {
    let q = getSupabase()
      .from("pin_uses")
      .select("id, staff_id, staff_name, staff_role, action, used_at, device_label", { count: "exact" })
      .order("used_at", { ascending: false });
    if (staffId) q = q.eq("staff_id", staffId);
    if (action) q = q.eq("action", action);
    const { data, error, count } = await q.range(offset, offset + PAGE - 1);
    if (error) return setError(errorMessage(error));
    setError(null);
    setCount(count ?? 0);
    setRows((prev) => (offset === 0 ? (data as PinUse[]) : [...(prev ?? []), ...(data as PinUse[])]));
  }, [staffId, action]);

  useEffect(() => { setRows(null); load(0); }, [load]);

  return (
    <>
      <PageHeader
        title="PIN log"
        subtitle="Every time a PIN was used on the tablet, by owners and staff. This log can't be edited or deleted."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Person" htmlFor="pl-staff">
          <select id="pl-staff" className="input" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Everyone</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="What for" htmlFor="pl-action">
          <select id="pl-action" className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Anything</option>
            {Object.entries(PIN_ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>
      <Notice className="mb-4">Uses on the tablet appear after it syncs.</Notice>
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {!rows ? <Spinner /> : rows.length === 0 ? <EmptyState>No PIN uses yet.</EmptyState> : (
        <>
          <p className="mb-2 text-sm text-ink-soft">{count} use{count === 1 ? "" : "s"}</p>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm" aria-label="PIN uses (read-only)">
              <thead className="bg-cream text-left text-ink-soft">
                <tr>
                  <th className="p-3 font-semibold">Time</th>
                  <th className="p-3 font-semibold">Name</th>
                  <th className="p-3 font-semibold">Role</th>
                  <th className="p-3 font-semibold">What for</th>
                  <th className="p-3 font-semibold">Device</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-crust-dark">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="p-3 whitespace-nowrap">{formatDateTime(r.used_at)}</td>
                    <td className="p-3 font-semibold">{r.staff_name}</td>
                    <td className="p-3">
                      {r.staff_role === "owner" ? <span className="badge bg-ube-light text-ube">Owner</span> : <span className="badge bg-crust text-ink">Staff</span>}
                    </td>
                    <td className="p-3">{PIN_ACTION_LABEL[r.action] ?? r.action}</td>
                    <td className="p-3 text-ink-soft">{r.device_label ?? "Owner pages"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length < count && (
            <button className="btn-secondary mt-4 w-full" onClick={() => load(rows.length)}>Load more ({count - rows.length} more)</button>
          )}
        </>
      )}
    </>
  );
}
