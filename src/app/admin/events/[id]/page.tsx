"use client";
import { use, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useConfirm } from "@/components/ConfirmModal";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { useOwner } from "../../OwnerContext";
import { Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { MoneyInput } from "@/components/MoneyInput";
import { Thumb } from "@/components/PhotoInput";
import { EventStatusBadge } from "@/components/StatusBadge";
import { formatPeso } from "@/lib/money";
import { errorMessage } from "@/lib/errors";
import { formatDateRange, formatDateTime, formatTime, timeAgo } from "@/lib/time";
import type { BundleRow, EventBundleRow, EventProductRow, EventRow, ProductRow } from "@/lib/types";

type ProductDraft = { included: boolean; epId?: string; price: number | null; starting: number; available: boolean; sort: number };
type BundleDraft = { included: boolean; ebId?: string; price: number | null; available: boolean; sort: number };
type Adjustment = { id: string; event_product_id: string; quantity_change: number; reason: string; note: string | null; created_at: string };
type Heartbeat = { last_seen_at: string; unsynced_count: number; oldest_unsynced_at: string | null };

const REASONS = [
  { value: "restock", label: "Restock (more arrived)", sign: 1 },
  { value: "waste", label: "Waste / damaged", sign: -1 },
  { value: "staff_meal", label: "Staff meal", sign: -1 },
  { value: "giveaway", label: "Giveaway / sample", sign: -1 },
  { value: "correction", label: "Count correction (+ or −)", sign: 0 },
] as const;

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const [ask, confirmEl] = useConfirm();
  const { id } = use(params);
  const { businessId } = useOwner();
  const [event, setEvent] = useState<EventRow | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [bundles, setBundles] = useState<BundleRow[]>([]);
  const [eps, setEps] = useState<EventProductRow[]>([]);
  const [productDrafts, setProductDrafts] = useState<Record<string, ProductDraft>>({});
  const [bundleDrafts, setBundleDrafts] = useState<Record<string, BundleDraft>>({});
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [heartbeat, setHeartbeat] = useState<Heartbeat | null>(null);
  const [openingFloat, setOpeningFloat] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState<EventProductRow | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);

  const load = useCallback(async (resetDrafts: boolean) => {
    const supabase = getSupabase();
    const [ev, pr, bu, ep, eb, adj, cash, hb] = await Promise.all([
      supabase.from("events").select("*").eq("id", id).single(),
      supabase.from("products").select("*").order("category").order("name"),
      supabase.from("bundles").select("*, bundle_items(product_id, quantity)").order("name"),
      supabase.from("event_products").select("*").eq("event_id", id),
      supabase.from("event_bundles").select("*").eq("event_id", id),
      supabase.from("stock_adjustments").select("id, event_product_id, quantity_change, reason, note, created_at").eq("event_id", id).order("created_at", { ascending: false }).limit(30),
      supabase.from("cash_sessions").select("opening_float_centavos").eq("event_id", id).maybeSingle(),
      supabase.from("device_heartbeats").select("last_seen_at, unsynced_count, oldest_unsynced_at").order("last_seen_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const firstError = [ev, pr, bu, ep, eb, adj, cash, hb].find((r) => r.error)?.error;
    if (firstError) return setError(errorMessage(firstError));
    setEvent(ev.data as EventRow);
    setProducts(pr.data as ProductRow[]);
    setBundles(bu.data as BundleRow[]);
    setEps(ep.data as EventProductRow[]);
    setAdjustments(adj.data as Adjustment[]);
    setHeartbeat(hb.data as Heartbeat | null);
    if (!resetDrafts) return;
    setOpeningFloat(cash.data?.opening_float_centavos ?? 0);
    const epByProduct = new Map((ep.data as EventProductRow[]).map((r) => [r.product_id, r]));
    setProductDrafts(Object.fromEntries((pr.data as ProductRow[]).map((p, i) => {
      const r = epByProduct.get(p.id);
      return [p.id, r
        ? { included: true, epId: r.id, price: r.price_centavos, starting: r.starting_stock, available: r.is_available, sort: r.sort_order }
        : { included: false, price: p.default_price_centavos, starting: 24, available: true, sort: 100 + i }];
    })));
    const ebByBundle = new Map((eb.data as EventBundleRow[]).map((r) => [r.bundle_id, r]));
    setBundleDrafts(Object.fromEntries((bu.data as BundleRow[]).map((b, i) => {
      const r = ebByBundle.get(b.id);
      return [b.id, r
        ? { included: true, ebId: r.id, price: r.price_centavos, available: r.is_available, sort: r.sort_order }
        : { included: false, price: b.price_centavos, available: true, sort: 100 + i }];
    })));
    setDirty(false);
  }, [id]);

  useEffect(() => { load(true); }, [load]);

  // While live, refresh stock numbers so owners see sales as the tablet syncs.
  useEffect(() => {
    if (event?.status !== "live") return;
    const t = setInterval(() => load(false), 20000);
    return () => clearInterval(t);
  }, [event?.status, load]);

  const epByProduct = useMemo(() => new Map(eps.map((r) => [r.product_id, r])), [eps]);
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const locked = event?.status === "closed";

  function updateProduct(pid: string, patch: Partial<ProductDraft>) {
    setProductDrafts((d) => ({ ...d, [pid]: { ...d[pid], ...patch } }));
    setDirty(true);
    setSaved(null);
  }
  function updateBundle(bid: string, patch: Partial<BundleDraft>) {
    setBundleDrafts((d) => ({ ...d, [bid]: { ...d[bid], ...patch } }));
    setDirty(true);
    setSaved(null);
  }

  async function saveMenu() {
    if (!event) return;
    setBusy(true);
    setError(null);
    const supabase = getSupabase();
    const problems: string[] = [];
    try {
      for (const p of products) {
        const d = productDrafts[p.id];
        const existing = epByProduct.get(p.id);
        if (d.included) {
          if (d.price == null) { problems.push(`${p.name}: enter a price`); continue; }
          const fields = { price_centavos: d.price, starting_stock: d.starting, is_available: d.available, sort_order: d.sort };
          if (!existing) {
            const { error } = await supabase.from("event_products").insert({ ...fields, business_id: businessId, event_id: event.id, product_id: p.id });
            if (error) problems.push(`${p.name}: ${errorMessage(error)}`);
          } else if (existing.price_centavos !== d.price || existing.starting_stock !== d.starting || existing.is_available !== d.available || existing.sort_order !== d.sort) {
            const { error } = await supabase.from("event_products").update(fields).eq("id", existing.id);
            if (error) problems.push(`${p.name}: ${errorMessage(error)}`);
          }
        } else if (existing) {
          const { error } = await supabase.from("event_products").delete().eq("id", existing.id);
          if (error) problems.push(`${p.name} already has sales or adjustments; mark it unavailable instead of removing it.`);
        }
      }
      const { data: ebRows } = await supabase.from("event_bundles").select("*").eq("event_id", event.id);
      const ebByBundle = new Map((ebRows as EventBundleRow[] ?? []).map((r) => [r.bundle_id, r]));
      for (const b of bundles) {
        const d = bundleDrafts[b.id];
        const existing = ebByBundle.get(b.id);
        if (d.included) {
          if (d.price == null) { problems.push(`${b.name}: enter a price`); continue; }
          const fields = { price_centavos: d.price, is_available: d.available, sort_order: d.sort };
          if (!existing) {
            const { error } = await supabase.from("event_bundles").insert({ ...fields, business_id: businessId, event_id: event.id, bundle_id: b.id });
            if (error) problems.push(`${b.name}: ${errorMessage(error)}`);
          } else if (existing.price_centavos !== d.price || existing.is_available !== d.available || existing.sort_order !== d.sort) {
            const { error } = await supabase.from("event_bundles").update(fields).eq("id", existing.id);
            if (error) problems.push(`${b.name}: ${errorMessage(error)}`);
          }
        } else if (existing) {
          const { error } = await supabase.from("event_bundles").delete().eq("id", existing.id);
          if (error) problems.push(`${b.name} already has sales; mark it unavailable instead of removing it.`);
        }
      }
      if (openingFloat != null) {
        const { error } = await supabase.rpc("set_opening_float", { p_event_id: event.id, p_opening_float_centavos: openingFloat });
        if (error) problems.push(`Opening float: ${errorMessage(error)}`);
      }
    } finally {
      setBusy(false);
    }
    if (problems.length) setError(problems.join(" · "));
    else setSaved(event.status === "live" ? "Saved. The tablet picks up changes on its next sync." : "Menu saved.");
    await load(true);
  }

  async function setStatus(status: "live" | "draft") {
    if (!event) return;
    if (dirty && !(await ask({ title: "Unsaved menu changes", body: "You have unsaved menu changes. Continue without saving?", confirmLabel: "Continue without saving" }))) return;
    const { error } = await getSupabase().rpc("set_event_status", { p_event_id: event.id, p_status: status });
    if (error) return setError(errorMessage(error));
    load(true);
  }

  async function toggleAvailable(ep: EventProductRow) {
    const { error } = await getSupabase().rpc("set_availability", { p_event_product_id: ep.id, p_available: !ep.is_available });
    if (error) return setError(errorMessage(error));
    load(true);
  }

  if (!event) return error ? <Notice tone="danger">{error}</Notice> : <Spinner />;

  const includedCount = Object.values(productDrafts).filter((d) => d.included).length;
  const bundleWarnings = bundles.flatMap((b) => {
    if (!bundleDrafts[b.id]?.included) return [];
    const missing = b.bundle_items.filter((i) => !productDrafts[i.product_id]?.included).map((i) => productById.get(i.product_id)?.name ?? "?");
    if (missing.length === 0) return [];
    return [b.type === "fixed"
      ? `${b.name} can't be sold: ${missing.join(", ")} not on this menu.`
      : `${b.name}: ${missing.join(", ")} not on this menu, so they can't be picked.`];
  });

  return (
    <>
      {confirmEl}
      <p className="mb-2 text-sm"><Link href="/admin/events" className="font-semibold text-caramel underline">← Events</Link></p>
      <PageHeader
        title={event.name}
        subtitle={<>{formatDateRange(event.starts_on, event.ends_on)}{event.venue ? ` · ${event.venue}` : ""} · <EventStatusBadge status={event.status} /></>}
        actions={
          <>
            <button className="btn-secondary" onClick={() => setEditingDetails(true)} disabled={locked}>Edit details</button>
            {event.status === "draft" && <button className="btn-primary" onClick={() => setStatus("live")}>Go live</button>}
            {event.status === "live" && <Link href={`/admin/events/${event.id}/close`} className="btn-primary">End of day / close</Link>}
            {event.status === "closed" && <Link href={`/admin/events/${event.id}/summary`} className="btn-primary">View summary</Link>}
            {event.status === "closed" && <button className="btn-ghost" onClick={async () => { if (await ask({ title: "Reopen event?", body: "Reopen this event for sales? Tablets can sell again once they sync.", confirmLabel: "Reopen", tone: "primary" })) await setStatus("live"); }}>Reopen</button>}
          </>
        }
      />

      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {saved && <Notice tone="ok" className="mb-4">{saved}</Notice>}
      {locked && <Notice className="mb-4">This event is closed. Sales are locked and the menu is read-only.</Notice>}
      {event.status === "live" && heartbeat && (
        <Notice tone={heartbeat.unsynced_count > 0 ? "warn" : "ok"} className="mb-4">
          POS tablet last checked in {timeAgo(heartbeat.last_seen_at)}
          {heartbeat.unsynced_count > 0
            ? ` · holding ${heartbeat.unsynced_count} unsynced sale(s) since ${formatTime(heartbeat.oldest_unsynced_at!)}`
            : " · all sales synced"}
        </Notice>
      )}
      {bundleWarnings.map((w) => <Notice key={w} tone="warn" className="mb-2">{w}</Notice>)}

      <section className="mb-8">
        <div className="mb-2 flex items-end justify-between gap-2">
          <h2 className="text-lg font-bold">Pastries <span className="text-sm font-normal text-ink-soft">({includedCount} on the menu)</span></h2>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-cream text-left text-ink-soft">
              <tr>
                <th className="p-3 font-semibold">On menu</th>
                <th className="p-3 font-semibold">Price</th>
                <th className="p-3 font-semibold">Starting stock</th>
                <th className="p-3 font-semibold">Order</th>
                <th className="p-3 font-semibold">Stock now</th>
                <th className="p-3 font-semibold">Available</th>
                <th className="p-3 font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-crust-dark">
              {products.filter((p) => p.active || productDrafts[p.id]?.included).map((p) => {
                const d = productDrafts[p.id];
                const ep = epByProduct.get(p.id);
                if (!d) return null;
                return (
                  <tr key={p.id} className={d.included ? "" : "opacity-60"}>
                    <td className="p-3">
                      <label className="flex items-center gap-3">
                        <input type="checkbox" className="h-5 w-5 accent-caramel" disabled={locked} checked={d.included} onChange={(e) => updateProduct(p.id, { included: e.target.checked })} />
                        <Thumb url={p.photo_url} name={p.name} size="sm" />
                        <span className="font-semibold">{p.name}</span>
                      </label>
                    </td>
                    <td className="w-36 p-2"><MoneyInput id={`price-${p.id}`} value={d.price} onChange={(v) => updateProduct(p.id, { price: v })} /></td>
                    <td className="w-28 p-2">
                      <input aria-label={`Starting stock for ${p.name}`} type="number" min={0} disabled={locked} className="input text-right" value={d.starting}
                        onChange={(e) => updateProduct(p.id, { starting: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                    </td>
                    <td className="w-24 p-2">
                      <input aria-label={`Sort order for ${p.name}`} type="number" disabled={locked} className="input text-right" value={d.sort}
                        onChange={(e) => updateProduct(p.id, { sort: Math.floor(Number(e.target.value) || 0) })} />
                    </td>
                    <td className="p-3 tabular-nums">
                      {ep ? (
                        <>
                          <span className={`font-bold ${ep.current_stock <= 0 ? "text-danger" : ep.current_stock <= event.low_stock_threshold ? "text-warn" : ""}`}>{ep.current_stock}</span>
                          {ep.current_stock <= 0 && <span className="badge ml-1 bg-danger-light text-danger">Sold out{ep.sold_out_at ? ` ${formatTime(ep.sold_out_at)}` : ""}</span>}
                        </>
                      ) : "-"}
                    </td>
                    <td className="p-3">
                      {ep ? (
                        <button className={`badge min-h-11 px-3 hover:brightness-95 active:brightness-90 ${ep.is_available ? "bg-ok-light text-ok" : "bg-danger-light text-danger"}`} disabled={locked}
                          onClick={() => toggleAvailable(ep)} aria-label={`${p.name} is ${ep.is_available ? "available" : "unavailable"}; toggle`}>
                          {ep.is_available ? "✓ Available" : "✕ Unavailable"}
                        </button>
                      ) : "-"}
                    </td>
                    <td className="p-3">{ep && !locked && <button className="btn-ghost min-h-11 text-sm" onClick={() => setAdjusting(ep)}>Restock / adjust</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-bold">Bundles</h2>
        <div className="card divide-y divide-crust-dark">
          {bundles.filter((b) => b.active || bundleDrafts[b.id]?.included).map((b) => {
            const d = bundleDrafts[b.id];
            if (!d) return null;
            return (
              <div key={b.id} className={`flex flex-wrap items-center gap-3 p-3 ${d.included ? "" : "opacity-60"}`}>
                <label className="flex min-w-56 flex-1 items-center gap-3">
                  <input type="checkbox" className="h-5 w-5 accent-caramel" disabled={locked} checked={d.included} onChange={(e) => updateBundle(b.id, { included: e.target.checked })} />
                  <Thumb url={b.photo_url} name={b.name} size="sm" />
                  <span>
                    <span className="font-semibold">{b.name}</span>
                    <span className="block text-xs text-ink-soft">{b.type === "fixed" ? "Fixed" : `Pick ${b.required_count}`} · catalog {formatPeso(b.price_centavos)}</span>
                  </span>
                </label>
                <div className="w-36"><MoneyInput id={`bprice-${b.id}`} value={d.price} onChange={(v) => updateBundle(b.id, { price: v })} /></div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-5 w-5 accent-caramel" disabled={locked || !d.included} checked={d.available} onChange={(e) => updateBundle(b.id, { available: e.target.checked })} />
                  Available
                </label>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mb-8 max-w-sm">
        <h2 className="mb-2 text-lg font-bold">Cash drawer</h2>
        <Field label="Opening float (change in the drawer at the start)" htmlFor="float">
          <MoneyInput id="float" value={openingFloat} onChange={(v) => { setOpeningFloat(v); setDirty(true); setSaved(null); }} />
        </Field>
      </section>

      {!locked && (
        <div className="no-print sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-crust-dark bg-cream/95 px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8">
          {dirty && <span className="text-sm font-semibold text-warn">● Unsaved changes</span>}
          <button className="btn-primary" onClick={saveMenu} disabled={busy || !dirty}>{busy ? "Saving…" : "Save menu"}</button>
        </div>
      )}

      {adjustments.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-bold">Stock adjustments</h2>
          <div className="card divide-y divide-crust-dark text-sm">
            {adjustments.map((a) => {
              const ep = eps.find((e) => e.id === a.event_product_id);
              return (
                <div key={a.id} className="flex flex-wrap gap-2 p-3">
                  <span className="w-28 text-ink-soft">{formatDateTime(a.created_at)}</span>
                  <span className="flex-1 font-semibold">{productById.get(ep?.product_id ?? "")?.name}</span>
                  <span className="capitalize">{a.reason.replace("_", " ")}{a.note ? `: ${a.note}` : ""}</span>
                  <span className={`w-12 text-right font-bold tabular-nums ${a.quantity_change > 0 ? "text-ok" : "text-danger"}`}>{a.quantity_change > 0 ? "+" : ""}{a.quantity_change}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <AdjustModal ep={adjusting} productName={productById.get(adjusting?.product_id ?? "")?.name ?? ""} onClose={() => setAdjusting(null)} onSaved={() => { setAdjusting(null); load(true); }} />
      <DetailsModal open={editingDetails} event={event} onClose={() => setEditingDetails(false)} onSaved={() => { setEditingDetails(false); load(false); }} />
    </>
  );
}

function AdjustModal({ ep, productName, onClose, onSaved }: { ep: EventProductRow | null; productName: string; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState<(typeof REASONS)[number]["value"]>("restock");
  const [qty, setQty] = useState(12);
  const [negative, setNegative] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReason("restock"); setQty(12); setNote(""); setNegative(false); setError(null); }, [ep]);

  const sign = REASONS.find((r) => r.value === reason)!.sign || (negative ? -1 : 1);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ep || qty <= 0) return;
    const { error } = await getSupabase().rpc("adjust_stock", {
      p_adjustment: { id: crypto.randomUUID(), event_product_id: ep.id, quantity_change: sign * qty, reason, note },
    });
    if (error) return setError(errorMessage(error));
    onSaved();
  }

  return (
    <Modal open={!!ep} onClose={onClose} title={`Adjust stock: ${productName}`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <p className="text-ink-soft">Stock now: <strong className="text-ink">{ep?.current_stock}</strong>. Starting stock stays unchanged.</p>
        <Field label="Reason" htmlFor="adj-reason">
          <select id="adj-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </Field>
        {reason === "correction" && (
          <div className="flex gap-2">
            <button type="button" className={`btn-secondary flex-1 ${!negative ? "border-caramel bg-crust" : ""}`} aria-pressed={!negative} onClick={() => setNegative(false)}>+ Add</button>
            <button type="button" className={`btn-secondary flex-1 ${negative ? "border-caramel bg-crust" : ""}`} aria-pressed={negative} onClick={() => setNegative(true)}>− Remove</button>
          </div>
        )}
        <Field label="Quantity" htmlFor="adj-qty">
          <input id="adj-qty" type="number" min={1} required className="input" value={qty} onChange={(e) => setQty(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
        </Field>
        <Field label="Note (optional)" htmlFor="adj-note">
          <input id="adj-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <p className="font-semibold">New stock: {(ep?.current_stock ?? 0) + sign * qty}</p>
        <button className="btn-primary w-full" disabled={qty <= 0}>Save {sign > 0 ? `+${qty}` : `−${qty}`}</button>
      </form>
    </Modal>
  );
}

function DetailsModal({ open, event, onClose, onSaved }: { open: boolean; event: EventRow; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(event.name);
  const [venue, setVenue] = useState(event.venue ?? "");
  const [startsOn, setStartsOn] = useState(event.starts_on);
  const [endsOn, setEndsOn] = useState(event.ends_on);
  const [threshold, setThreshold] = useState(event.low_stock_threshold);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setName(event.name); setVenue(event.venue ?? ""); setStartsOn(event.starts_on); setEndsOn(event.ends_on); setThreshold(event.low_stock_threshold); setError(null); }
  }, [open, event]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { error } = await getSupabase().from("events")
      .update({ name, venue: venue || null, starts_on: startsOn, ends_on: endsOn, low_stock_threshold: threshold }).eq("id", event.id);
    if (error) return setError(errorMessage(error));
    onSaved();
  }

  return (
    <Modal open={open} onClose={onClose} title="Event details">
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="Name" htmlFor="d-name"><input id="d-name" required className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Venue" htmlFor="d-venue"><input id="d-venue" className="input" value={venue} onChange={(e) => setVenue(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" htmlFor="d-start"><input id="d-start" type="date" required className="input" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></Field>
          <Field label="Ends" htmlFor="d-end"><input id="d-end" type="date" required min={startsOn} className="input" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></Field>
        </div>
        <Field label="Low-stock warning at" htmlFor="d-low" hint="POS shows a 'Low' badge when stock is at or below this number.">
          <input id="d-low" type="number" min={0} className="input w-32" value={threshold} onChange={(e) => setThreshold(Math.max(0, Number(e.target.value) || 0))} />
        </Field>
        <button className="btn-primary w-full">Save</button>
      </form>
    </Modal>
  );
}
