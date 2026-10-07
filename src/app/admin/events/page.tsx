"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { useOwner } from "../OwnerContext";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { EventStatusBadge } from "@/components/StatusBadge";
import { errorMessage } from "@/lib/errors";
import { formatDateRange, manilaDate } from "@/lib/time";
import type { EventRow } from "@/lib/types";

export default function EventsPage() {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await getSupabase().from("events").select("*").order("starts_on", { ascending: false }).order("created_at", { ascending: false });
    if (error) setError(errorMessage(error));
    else setEvents(data as EventRow[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader
        title="Events"
        subtitle="A pop-up or selling day: its menu, prices, stock and sales."
        actions={<button className="btn-primary" onClick={() => setCreating(true)}>+ New event</button>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {!events ? <Spinner /> : events.length === 0 ? <EmptyState>No events yet. Create your first pop-up.</EmptyState> : (
        <div className="card divide-y divide-crust-dark">
          {events.map((e) => (
            <Link key={e.id} href={`/admin/events/${e.id}`} className="flex flex-wrap items-center gap-3 p-4 hover:bg-cream">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{e.name}</p>
                <p className="text-sm text-ink-soft">{formatDateRange(e.starts_on, e.ends_on)}{e.venue ? ` · ${e.venue}` : ""}</p>
              </div>
              <EventStatusBadge status={e.status} />
            </Link>
          ))}
        </div>
      )}
      <NewEventModal open={creating} events={events ?? []} onClose={() => setCreating(false)} />
    </>
  );
}

function NewEventModal({ open, events, onClose }: { open: boolean; events: EventRow[]; onClose: () => void }) {
  const { businessId } = useOwner();
  const router = useRouter();
  const today = manilaDate();
  const [name, setName] = useState("");
  const [venue, setVenue] = useState("");
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState(today);
  const [copyFrom, setCopyFrom] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      // "Duplicate last event" is the default: reuse the most recent menu.
      const last = events[0];
      setCopyFrom(last?.id ?? "");
      setVenue(last?.venue ?? "");
      setName(""); setStartsOn(today); setEndsOn(today); setError(null);
    }
  }, [open, events, today]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (endsOn < startsOn) return setError("End date must be on or after the start date.");
    setBusy(true);
    const supabase = getSupabase();
    let id: string | null = null;
    if (copyFrom) {
      const { data, error } = await supabase.rpc("duplicate_event", {
        p_source_event_id: copyFrom, p_name: name, p_venue: venue || null, p_starts_on: startsOn, p_ends_on: endsOn,
      });
      if (error) { setBusy(false); return setError(errorMessage(error)); }
      id = data as string;
    } else {
      const { data, error } = await supabase.from("events")
        .insert({ business_id: businessId, name, venue: venue || null, starts_on: startsOn, ends_on: endsOn }).select("id").single();
      if (error) { setBusy(false); return setError(errorMessage(error)); }
      id = data.id;
    }
    setBusy(false);
    router.push(`/admin/events/${id}`);
  }

  return (
    <Modal open={open} onClose={onClose} title="New event">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Event name" htmlFor="e-name">
          <input id="e-name" required className="input" placeholder="e.g. Salcedo Market — Oct 18" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Venue" htmlFor="e-venue">
          <input id="e-venue" className="input" value={venue} onChange={(e) => setVenue(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" htmlFor="e-start">
            <input id="e-start" type="date" required className="input" value={startsOn} onChange={(e) => { setStartsOn(e.target.value); if (endsOn < e.target.value) setEndsOn(e.target.value); }} />
          </Field>
          <Field label="Ends" htmlFor="e-end">
            <input id="e-end" type="date" required className="input" value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>
        <Field label="Menu" htmlFor="e-copy" hint="Copies products, prices, starting stock and bundles. You can change them after.">
          <select id="e-copy" className="input" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">Start with an empty menu</option>
            {events.map((ev, i) => (
              <option key={ev.id} value={ev.id}>{i === 0 ? "Duplicate last event: " : "Copy from: "}{ev.name} ({formatDateRange(ev.starts_on, ev.ends_on)})</option>
            ))}
          </select>
        </Field>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Creating…" : "Create event"}</button>
      </form>
    </Modal>
  );
}
