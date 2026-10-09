"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useOwner } from "../OwnerContext";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { MoneyInput } from "@/components/MoneyInput";
import { PhotoInput, Thumb } from "@/components/PhotoInput";
import { formatPeso } from "@/lib/money";
import { errorMessage } from "@/lib/errors";
import { fixedBundleEconomics, mixBundleEconomics, type BundleScenario, type CatalogProduct } from "@/lib/catalog";
import type { BundleRow, ProductRow } from "@/lib/types";

export default function BundlesPage() {
  const [bundles, setBundles] = useState<BundleRow[] | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BundleRow | "new" | null>(null);

  const load = useCallback(async () => {
    const supabase = getSupabase();
    const [b, p] = await Promise.all([
      supabase.from("bundles").select("*, bundle_items(id, product_id, quantity)").order("active", { ascending: false }).order("name"),
      supabase.from("products").select("*").order("name"),
    ]);
    if (b.error || p.error) return setError(errorMessage(b.error ?? p.error));
    setBundles(b.data as BundleRow[]);
    setProducts(p.data as ProductRow[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  const productMap = useMemo(
    () => new Map<string, CatalogProduct>(products.map((p) => [p.id, { id: p.id, name: p.name, price: p.default_price_centavos, cost: p.cost_centavos }])),
    [products],
  );

  return (
    <>
      <PageHeader
        title="Bundles"
        subtitle="Selling a bundle takes stock from its component pastries."
        actions={<button className="btn-primary" onClick={() => setEditing("new")}>+ Add bundle</button>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {!bundles ? <Spinner /> : bundles.length === 0 ? <EmptyState>No bundles yet.</EmptyState> : (
        <div className="grid gap-3 md:grid-cols-2">
          {bundles.map((b) => (
            <button key={b.id} onClick={() => setEditing(b)} className="card flex gap-3 p-4 text-left hover:bg-cream">
              <Thumb url={b.photo_url} name={b.name} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {b.name}{" "}
                  <span className={`badge ${b.type === "fixed" ? "bg-crust text-caramel" : "bg-ube-light text-ube"}`}>
                    {b.type === "fixed" ? "Fixed" : `Pick ${b.required_count}`}
                  </span>
                  {!b.active && <span className="badge ml-1 bg-crust text-ink-soft">Inactive</span>}
                </p>
                <p className="text-sm text-ink-soft">
                  {b.type === "fixed"
                    ? b.bundle_items.map((i) => `${i.quantity}× ${productMap.get(i.product_id)?.name ?? "?"}`).join(", ")
                    : `From: ${b.bundle_items.map((i) => productMap.get(i.product_id)?.name ?? "?").join(", ")}`}
                </p>
                <BundleSummary bundle={b} products={productMap} />
              </div>
              <p className="font-bold tabular-nums">{formatPeso(b.price_centavos)}</p>
            </button>
          ))}
        </div>
      )}
      <BundleEditor bundle={editing} products={products} productMap={productMap} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
    </>
  );
}

function BundleSummary({ bundle, products }: { bundle: BundleRow; products: Map<string, CatalogProduct> }) {
  if (bundle.type === "fixed") {
    const e = fixedBundleEconomics(bundle.price_centavos, bundle.bundle_items.map((i) => ({ productId: i.product_id, quantity: i.quantity })), products);
    if (!e) return null;
    return <p className="mt-1 text-sm">Customer saves {formatPeso(e.discount)} · margin {formatPeso(e.bundleMargin)}</p>;
  }
  const e = mixBundleEconomics(bundle.price_centavos, bundle.required_count ?? 0, bundle.bundle_items.map((i) => i.product_id), products);
  if (!e) return null;
  return <p className="mt-1 text-sm">Margin {formatPeso(e.worst.bundleMargin)}–{formatPeso(e.best.bundleMargin)} depending on picks</p>;
}

function EconomicsTable({ scenarios, price }: { scenarios: BundleScenario[]; price: number }) {
  return (
    <div className="overflow-x-auto rounded-xl bg-cream p-3" aria-live="polite">
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-left text-ink-soft">
            <th className="py-1 font-semibold">Scenario</th>
            <th className="py-1 text-right font-semibold">Separately</th>
            <th className="py-1 text-right font-semibold">Bundle</th>
            <th className="py-1 text-right font-semibold">Margin (bundle)</th>
            <th className="py-1 text-right font-semibold">Margin (separate)</th>
            <th className="py-1 text-right font-semibold">Per piece Δ</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s) => (
            <tr key={s.label} className="border-t border-crust-dark">
              <td className="py-1">{s.label}</td>
              <td className="py-1 text-right">{formatPeso(s.separatePrice)}</td>
              <td className="py-1 text-right">{formatPeso(price)}</td>
              <td className={`py-1 text-right font-semibold ${s.bundleMargin < 0 ? "text-danger" : ""}`}>{formatPeso(s.bundleMargin)}</td>
              <td className="py-1 text-right">{formatPeso(s.separateMargin)}</td>
              <td className="py-1 text-right">{formatPeso(Math.round(s.bundleMarginPerPiece - s.separateMarginPerPiece))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {scenarios.some((s) => s.discount < 0) && (
        <p className="mt-2 text-sm font-semibold text-warn">⚠ This bundle costs more than buying the items separately.</p>
      )}
    </div>
  );
}

function BundleEditor({ bundle, products, productMap, onClose, onSaved }: {
  bundle: BundleRow | "new" | null; products: ProductRow[]; productMap: Map<string, CatalogProduct>; onClose: () => void; onSaved: () => void;
}) {
  const { businessId } = useOwner();
  const isNew = bundle === "new";
  const [name, setName] = useState("");
  const [type, setType] = useState<"fixed" | "mix_match">("fixed");
  const [price, setPrice] = useState<number | null>(null);
  const [requiredCount, setRequiredCount] = useState(6);
  const [photo, setPhoto] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [items, setItems] = useState<{ product_id: string; quantity: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    if (bundle && bundle !== "new") {
      setName(bundle.name); setType(bundle.type); setPrice(bundle.price_centavos);
      setRequiredCount(bundle.required_count ?? 6); setPhoto(bundle.photo_url); setActive(bundle.active);
      setItems(bundle.bundle_items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })));
    } else {
      setName(""); setType("fixed"); setPrice(null); setRequiredCount(6); setPhoto(null); setActive(true); setItems([]);
    }
  }, [bundle]);

  const activeProducts = products.filter((p) => p.active || items.some((i) => i.product_id === p.id));
  const scenarios: BundleScenario[] = useMemo(() => {
    if (price == null) return [];
    if (type === "fixed") {
      const e = fixedBundleEconomics(price, items.map((i) => ({ productId: i.product_id, quantity: i.quantity })), productMap);
      return e ? [e] : [];
    }
    const e = mixBundleEconomics(price, requiredCount, items.map((i) => i.product_id), productMap);
    return e ? [{ ...e.best, label: `Best case: ${e.best.label}` }, { ...e.worst, label: `Worst case: ${e.worst.label}` }] : [];
  }, [price, type, items, requiredCount, productMap]);

  function toggleEligible(id: string) {
    setItems((cur) => (cur.some((i) => i.product_id === id) ? cur.filter((i) => i.product_id !== id) : [...cur, { product_id: id, quantity: 1 }]));
  }
  function setQty(id: string, qty: number) {
    setItems((cur) => (qty <= 0 ? cur.filter((i) => i.product_id !== id) : cur.map((i) => (i.product_id === id ? { ...i, quantity: qty } : i))));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (price == null) return setError("Enter the bundle price.");
    if (items.length === 0) return setError(type === "fixed" ? "Add at least one product to the bundle." : "Pick the eligible products.");
    if (type === "mix_match" && requiredCount < 1) return setError("How many items does the customer pick?");
    setBusy(true);
    setError(null);
    try {
      const supabase = getSupabase();
      const row = {
        name: name.trim(), type, price_centavos: price, photo_url: photo, active,
        required_count: type === "mix_match" ? requiredCount : null,
      };
      let id: string;
      if (isNew) {
        const { data, error } = await supabase.from("bundles").insert({ ...row, business_id: businessId }).select("id").single();
        if (error) throw error;
        id = data.id;
      } else {
        id = (bundle as BundleRow).id;
        const { error } = await supabase.from("bundles").update(row).eq("id", id);
        if (error) throw error;
        const del = await supabase.from("bundle_items").delete().eq("bundle_id", id);
        if (del.error) throw del.error;
      }
      const { error: itemsError } = await supabase.from("bundle_items").insert(
        items.map((i) => ({ business_id: businessId, bundle_id: id, product_id: i.product_id, quantity: type === "fixed" ? i.quantity : 1 })),
      );
      if (itemsError) throw itemsError;
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={!!bundle} onClose={onClose} title={isNew ? "Add bundle" : "Edit bundle"} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <PhotoInput businessId={businessId} value={photo} onChange={setPhoto} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="b-name">
            <input id="b-name" required className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Bundle price" htmlFor="b-price">
            <MoneyInput id="b-price" required value={price} onChange={setPrice} />
          </Field>
        </div>
        <fieldset>
          <legend className="label">Type</legend>
          <div className="grid grid-cols-2 gap-2">
            {([["fixed", "Fixed contents", "e.g. Ube Box = 6 ube croissants"], ["mix_match", "Mix and match", "e.g. any 6 croissants"]] as const).map(([value, title, hint]) => (
              <label key={value} className={`card cursor-pointer p-3 ${type === value ? "border-2 border-caramel bg-crust" : ""}`}>
                <input type="radio" name="b-type" value={value} checked={type === value} onChange={() => setType(value)} className="sr-only" />
                <span className="block font-semibold">{type === value ? "● " : "○ "}{title}</span>
                <span className="text-sm text-ink-soft">{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {type === "fixed" ? (
          <div>
            <p className="label">Contents</p>
            <div className="divide-y divide-crust-dark rounded-xl border border-crust-dark">
              {activeProducts.map((p) => {
                const qty = items.find((i) => i.product_id === p.id)?.quantity ?? 0;
                return (
                  <div key={p.id} className="flex items-center gap-3 px-3 py-1">
                    <span className="flex-1">{p.name} <span className="text-sm text-ink-soft">{formatPeso(p.default_price_centavos)}</span></span>
                    <button type="button" className="btn-ghost min-h-11 w-11 px-0" aria-label={`Fewer ${p.name}`} onClick={() => setQty(p.id, qty - 1)} disabled={qty === 0}>−</button>
                    <span className="w-8 text-center font-bold tabular-nums" aria-label={`${qty} ${p.name}`}>{qty}</span>
                    <button type="button" className="btn-ghost min-h-11 w-11 px-0" aria-label={`More ${p.name}`}
                      onClick={() => (qty === 0 ? setItems((c) => [...c, { product_id: p.id, quantity: 1 }]) : setQty(p.id, qty + 1))}>+</button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Customer picks how many items?" htmlFor="b-count">
              <input id="b-count" type="number" inputMode="numeric" min={1} max={50} className="input w-32" value={requiredCount} onChange={(e) => setRequiredCount(Number(e.target.value))} />
            </Field>
            <div>
              <p className="label">Eligible products (repeats allowed)</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {activeProducts.map((p) => {
                  const on = items.some((i) => i.product_id === p.id);
                  return (
                    <label key={p.id} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border-2 px-3 ${on ? "border-ube bg-ube-light" : "border-crust-dark"}`}>
                      <input type="checkbox" className="h-5 w-5 accent-ube" checked={on} onChange={() => toggleEligible(p.id)} />
                      {p.name}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {scenarios.length > 0 && price != null && <EconomicsTable scenarios={scenarios} price={price} />}

        <label className="flex min-h-12 items-center gap-3">
          <input type="checkbox" className="h-5 w-5 accent-caramel" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active (can be added to events)
        </label>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Saving…" : "Save bundle"}</button>
      </form>
    </Modal>
  );
}
