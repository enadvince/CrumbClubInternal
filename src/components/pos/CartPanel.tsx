"use client";
import { formatPeso } from "@/lib/money";
import type { Discount, Menu, PricedCart } from "@/lib/pos/types";
import type { BundleSuggestion } from "@/lib/pos/suggest";
import { tapFeedback } from "./feedback";

export function CartPanel({
  priced, menu, discount, suggestion, canIncrement, onChange, onClear, onApplySuggestion, onDiscount, onRemoveDiscount, onCheckout, locked,
}: {
  priced: PricedCart;
  menu: Menu;
  discount: Discount | null;
  suggestion: BundleSuggestion | null;
  canIncrement: (lineId: string) => boolean;
  onChange: (lineId: string, delta: number) => void;
  onClear: () => void;
  onApplySuggestion: () => void;
  onDiscount: () => void;
  onRemoveDiscount: () => void;
  onCheckout: () => void;
  locked: boolean;
}) {
  const empty = priced.lines.length === 0;
  return (
    <aside aria-label="Cart" className="flex h-full min-h-0 flex-col border-l-2 border-crust-dark bg-paper">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-lg font-black">
          Cart {priced.itemCount > 0 && <span className="text-ink-soft">· {priced.itemCount} item{priced.itemCount === 1 ? "" : "s"}</span>}
        </h2>
        {!empty && (
          <button className="btn-ghost min-h-11 text-sm text-danger" onClick={() => { tapFeedback(); onClear(); }}>
            ✕ Clear cart
          </button>
        )}
      </div>

      <ul className="min-h-0 flex-1 divide-y divide-crust-dark overflow-y-auto px-4">
        {empty && <li className="py-10 text-center text-ink-soft">Tap a pastry or bundle to add it.</li>}
        {priced.lines.map((l) => {
          const bundle = l.line.kind === "bundle" ? menu.bundles.get(l.line.eventBundleId) : null;
          const perBundle = l.line.kind === "bundle" ? l.components.map((c) => `${c.quantity / l.line.quantity}× ${c.name}`) : [];
          return (
            <li key={l.line.id} className="py-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="leading-tight font-bold">
                    {bundle && <span className="badge mr-1 bg-ube-light align-middle text-ube">Bundle</span>}
                    {l.name}
                  </p>
                  {perBundle.length > 0 && <p className="text-xs leading-snug text-ink-soft">{perBundle.join(" · ")}</p>}
                  <p className="text-xs text-ink-soft">{formatPeso(l.unitPrice, { trimZeros: true })} each</p>
                </div>
                <p className="font-bold tabular-nums">{formatPeso(l.lineTotal)}</p>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <button
                  className="btn-secondary h-12 w-14 px-0 text-2xl"
                  onClick={() => { tapFeedback(); onChange(l.line.id, -1); }}
                  aria-label={l.line.quantity === 1 ? `Remove ${l.name}` : `One fewer ${l.name}`}
                >
                  {l.line.quantity === 1 ? "🗑" : "−"}
                </button>
                <span className="w-10 text-center text-xl font-black tabular-nums" aria-label={`Quantity ${l.line.quantity}`}>{l.line.quantity}</span>
                <button
                  className="btn-secondary h-12 w-14 px-0 text-2xl"
                  disabled={!canIncrement(l.line.id)}
                  onClick={() => { tapFeedback(); onChange(l.line.id, 1); }}
                  aria-label={`One more ${l.name}`}
                >
                  +
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {suggestion && (
        <div className="mx-4 mb-2 rounded-xl border-2 border-ube bg-ube-light p-2">
          <button className="btn-ube min-h-12 w-full text-left text-sm" onClick={() => { tapFeedback(); onApplySuggestion(); }}>
            💡 Switch to {suggestion.name} and save {formatPeso(suggestion.savings, { trimZeros: true })}
          </button>
        </div>
      )}

      <div className="space-y-1 border-t-2 border-crust-dark px-4 py-3">
        <div className="flex justify-between text-ink-soft"><span>Subtotal</span><span className="tabular-nums">{formatPeso(priced.subtotal)}</span></div>
        {discount && priced.discount > 0 ? (
          <div className="flex items-center justify-between text-ok">
            <span className="flex items-center gap-1">
              Discount{discount.type === "percent" ? ` ${discount.value / 100}%` : ""} <span className="text-xs">({discount.reason})</span>
              <button className="btn-ghost min-h-11 min-w-11 px-2 text-xs" onClick={onRemoveDiscount} aria-label="Remove discount">✕</button>
            </span>
            <span className="tabular-nums">−{formatPeso(priced.discount)}</span>
          </div>
        ) : (
          !empty && <button className="text-sm font-semibold text-caramel underline" onClick={onDiscount}>+ Add discount</button>
        )}
        <div className="flex items-end justify-between pt-1">
          <span className="text-lg font-bold">Total</span>
          <span className="text-3xl font-black tabular-nums">{formatPeso(priced.total)}</span>
        </div>
        <button className="btn-primary mt-2 h-16 w-full text-xl" disabled={empty || locked} onClick={() => { tapFeedback(); onCheckout(); }}>
          {locked ? "Sales locked" : `Checkout ${empty ? "" : formatPeso(priced.total, { trimZeros: true })}`}
        </button>
      </div>
    </aside>
  );
}
