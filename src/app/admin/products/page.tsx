"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { useOwner } from "../OwnerContext";
import { EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { MoneyInput } from "@/components/MoneyInput";
import { PhotoInput, Thumb } from "@/components/PhotoInput";
import { formatPeso, marginPercent } from "@/lib/money";
import { errorMessage } from "@/lib/errors";
import type { ProductRow } from "@/lib/types";

export default function ProductsPage() {
  const [products, setProducts] = useState<ProductRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProductRow | "new" | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await getSupabase().from("products").select("*").order("category").order("name");
    if (error) setError(errorMessage(error));
    else setProducts(data as ProductRow[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, ProductRow[]>();
    for (const p of products ?? []) {
      if (!showInactive && !p.active) continue;
      map.set(p.category, [...(map.get(p.category) ?? []), p]);
    }
    return [...map.entries()];
  }, [products, showInactive]);

  const categories = useMemo(() => [...new Set((products ?? []).map((p) => p.category))], [products]);

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="Your master catalog. Prices here are defaults; each event can set its own."
        actions={<button className="btn-primary" onClick={() => setEditing("new")}>+ Add product</button>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-5 w-5 accent-caramel" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        Show inactive products
      </label>
      {!products ? <Spinner /> : grouped.length === 0 ? (
        <EmptyState>No products yet. Add your first pastry.</EmptyState>
      ) : (
        <div className="space-y-6">
          {grouped.map(([category, items]) => (
            <section key={category}>
              <h2 className="mb-2 text-sm font-bold tracking-wide text-ink-soft uppercase">{category}</h2>
              <div className="card divide-y divide-crust-dark">
                {items.map((p) => {
                  const m = marginPercent(p.default_price_centavos, p.cost_centavos);
                  return (
                    <button key={p.id} onClick={() => setEditing(p)} className="flex w-full items-center gap-3 p-3 text-left hover:bg-cream">
                      <Thumb url={p.photo_url} name={p.name} />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{p.name} {!p.active && <span className="badge bg-crust text-ink-soft">Inactive</span>}</p>
                        <p className="text-sm text-ink-soft">Cost {formatPeso(p.cost_centavos)}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold tabular-nums">{formatPeso(p.default_price_centavos)}</p>
                        <p className={`text-sm tabular-nums ${m != null && m < 30 ? "text-danger" : "text-ok"}`}>
                          {formatPeso(p.default_price_centavos - p.cost_centavos)} · {m == null ? "—" : `${m.toFixed(0)}%`} margin
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      <ProductEditor
        product={editing}
        categories={categories}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
    </>
  );
}

function ProductEditor({ product, categories, onClose, onSaved }: {
  product: ProductRow | "new" | null; categories: string[]; onClose: () => void; onSaved: () => void;
}) {
  const { businessId } = useOwner();
  const isNew = product === "new";
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Pastries");
  const [price, setPrice] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    if (product && product !== "new") {
      setName(product.name); setCategory(product.category); setPrice(product.default_price_centavos);
      setCost(product.cost_centavos); setPhoto(product.photo_url); setActive(product.active);
    } else {
      setName(""); setCategory(categories[0] ?? "Pastries"); setPrice(null); setCost(null); setPhoto(null); setActive(true);
    }
  }, [product, categories]);

  const margin = price != null && cost != null ? price - cost : null;
  const marginPct = price != null && cost != null ? marginPercent(price, cost) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (price == null || cost == null) return setError("Enter both price and cost per piece.");
    setBusy(true);
    const row = { name: name.trim(), category: category.trim() || "Pastries", default_price_centavos: price, cost_centavos: cost, photo_url: photo, active };
    const supabase = getSupabase();
    const { error } = isNew
      ? await supabase.from("products").insert({ ...row, business_id: businessId })
      : await supabase.from("products").update(row).eq("id", (product as ProductRow).id);
    setBusy(false);
    if (error) return setError(errorMessage(error));
    onSaved();
  }

  return (
    <Modal open={!!product} onClose={onClose} title={isNew ? "Add product" : "Edit product"}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <PhotoInput businessId={businessId} value={photo} onChange={setPhoto} />
        <Field label="Name" htmlFor="p-name">
          <input id="p-name" required className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Category" htmlFor="p-cat">
          <input id="p-cat" list="p-cat-list" className="input" value={category} onChange={(e) => setCategory(e.target.value)} />
          <datalist id="p-cat-list">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default price" htmlFor="p-price">
            <MoneyInput id="p-price" required value={price} onChange={setPrice} />
          </Field>
          <Field label="Cost per piece (required)" htmlFor="p-cost">
            <MoneyInput id="p-cost" required value={cost} onChange={setCost} />
          </Field>
        </div>
        <div aria-live="polite" className={`rounded-xl p-3 ${margin != null && margin < 0 ? "bg-danger-light text-danger" : "bg-cream"}`}>
          <p className="text-sm text-ink-soft">Unit margin</p>
          <p className="text-xl font-bold tabular-nums">
            {margin == null ? "—" : formatPeso(margin)}
            <span className="ml-2 text-base font-semibold">{marginPct == null ? "" : `${marginPct.toFixed(1)}%`}</span>
          </p>
          {margin != null && margin < 0 && <p className="text-sm font-semibold">⚠ You lose money on each sale at this price.</p>}
        </div>
        <label className="flex min-h-12 items-center gap-3">
          <input type="checkbox" className="h-5 w-5 accent-caramel" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active (can be added to events)
        </label>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Saving…" : "Save product"}</button>
      </form>
    </Modal>
  );
}
