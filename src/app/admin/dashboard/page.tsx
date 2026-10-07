"use client";
import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { EmptyState, Notice, PageHeader, Spinner } from "@/components/ui";
import { DashboardBody } from "@/components/dashboard/DashboardBody";
import { errorMessage } from "@/lib/errors";
import { formatDateTime, manilaDate, timeAgo } from "@/lib/time";
import { previousScope, resolveScope, type DashboardReport, type EventLite, type Preset, type Scope } from "@/lib/dashboard";

const PRESETS: [Preset, string][] = [
  ["today", "Today"], ["event", "Event"], ["date", "Specific date"], ["week", "This week"], ["month", "This month"], ["custom", "Custom"],
];

async function fetchReport(scope: Scope): Promise<DashboardReport> {
  const { data, error } = await getSupabase().rpc("dashboard_report", { p_from: scope.from, p_to: scope.to, p_event_id: scope.eventId });
  if (error) throw error;
  return data as DashboardReport;
}

export default function DashboardPage() {
  const today = manilaDate();
  const [events, setEvents] = useState<EventLite[] | null>(null);
  const [preset, setPreset] = useState<Preset>("today");
  const [date, setDate] = useState(today);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [eventId, setEventId] = useState<string>("");
  const [compare, setCompare] = useState(true);
  const [report, setReport] = useState<DashboardReport | null>(null);
  const [prev, setPrev] = useState<DashboardReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSupabase().from("events").select("id, name, starts_on, ends_on, status").order("starts_on", { ascending: false })
      .then(({ data }) => {
        const list = (data as EventLite[]) ?? [];
        setEvents(list);
        const live = list.find((e) => e.status === "live") ?? list[0];
        if (live) setEventId(live.id);
        // Default to the live event when there is one.
        if (list.some((e) => e.status === "live")) setPreset("event");
      });
  }, []);

  const event = events?.find((e) => e.id === eventId) ?? null;
  const scope = useMemo(() => resolveScope(preset, { today, date, from, to, event }), [preset, today, date, from, to, event]);
  const prevScope = useMemo(() => (compare && events ? previousScope(scope, events) : null), [compare, scope, events]);

  useEffect(() => {
    if (!events) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchReport(scope), prevScope ? fetchReport(prevScope) : Promise.resolve(null)])
      .then(([r, p]) => { if (!cancelled) { setReport(r); setPrev(p); setError(null); } })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [scope, prevScope, events]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={report?.sync.last_synced_at
          ? <>Last synced from the tablet: <strong>{formatDateTime(report.sync.last_synced_at)}</strong> ({timeAgo(report.sync.last_synced_at)})</>
          : "No sales synced yet."}
      />
      {report?.sync.device_unsynced_count ? (
        <Notice tone="warn" className="mb-4">
          The tablet reported {report.sync.device_unsynced_count} sale(s) not yet synced
          {report.sync.device_last_seen_at ? ` (last check-in ${timeAgo(report.sync.device_last_seen_at)})` : ""}. Figures below may be incomplete.
        </Notice>
      ) : null}

      <div className="card no-print mb-4 flex flex-wrap items-end gap-3 p-3" role="group" aria-label="Filters">
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Period">
          {PRESETS.map(([p, label]) => (
            <button key={p} role="radio" aria-checked={preset === p} onClick={() => setPreset(p)}
              className={`btn min-h-11 border-2 px-3 text-sm ${preset === p ? "border-caramel bg-caramel text-white" : "border-crust-dark bg-paper text-ink"}`}>
              {label}
            </button>
          ))}
        </div>
        {preset === "event" && (
          <label className="text-sm">
            <span className="label">Event</span>
            <select className="input min-w-56" value={eventId} onChange={(e) => setEventId(e.target.value)}>
              {(events ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}{e.status === "live" ? " (live)" : ""}</option>)}
            </select>
          </label>
        )}
        {preset === "date" && (
          <label className="text-sm"><span className="label">Date</span><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        )}
        {preset === "custom" && (
          <>
            <label className="text-sm"><span className="label">From</span><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-sm"><span className="label">To</span><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        )}
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-caramel" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          Compare to {scope.eventId ? "previous event" : "previous period"}
        </label>
      </div>

      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {!report ? <Spinner /> : report.kpis.transactions === 0 ? (
        <EmptyState>No sales for {scope.label}.{loading ? " Loading…" : ""}</EmptyState>
      ) : (
        <div className={`space-y-4 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <DashboardBody report={report} prev={prev} prevLabel={prevScope?.label} />
        </div>
      )}
    </>
  );
}
