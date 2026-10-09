"use client";
import { useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { formatPeso } from "@/lib/money";
import { eligibleProducts, isTracked } from "@/lib/pos/cart";
import type { Menu, MenuBundle, Pick } from "@/lib/pos/types";
import { tapFeedback } from "./feedback";

/** Mix-and-match: tap eligible items until the count is reached, then add to cart. */
export function MixPicker({
  bundle, menu, remaining, onClose, onAdd,
}: {
  bundle: MenuBundle | null;
  menu: Menu;
  remaining: ReadonlyMap<string, number>;
  onClose: () => void;
  onAdd: (picks: Pick[]) => void;
}) {
  const [picks, setPicks] = useState<Record<string, number>>({});
  const required = bundle?.required_count ?? 0;
  const chosen = Object.values(picks).reduce((a, b) => a + b, 0);
  const products = useMemo(() => (bundle ? eligibleProducts(menu, bundle) : []), [bundle, menu]);

  function close() {
    setPicks({});
    onClose();
  }
  function change(ep: string, delta: number) {
    tapFeedback();
    setPicks((p) => {
      const next = Math.max(0, (p[ep] ?? 0) + delta);
      const copy = { ...p, [ep]: next };
      if (next === 0) delete copy[ep];
      return copy;
    });
  }

  return (
    <Modal open={!!bundle} onClose={close} title={bundle ? `${bundle.name}: pick ${required}` : ""} wide>
      {bundle && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-lg font-bold" role="status" aria-live="polite">
              {chosen} of {required} chosen
            </p>
            <div className="h-3 flex-1 overflow-hidden rounded-full bg-crust" aria-hidden>
              <div className="h-full bg-ube transition-all" style={{ width: `${Math.min(100, (chosen / required) * 100)}%` }} />
            </div>
            {chosen > 0 && <button className="btn-ghost min-h-11 text-sm" onClick={() => setPicks({})}>Clear</button>}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {products.map((p) => {
              const picked = picks[p.event_product_id] ?? 0;
              const tracked = isTracked(p);
              const left = (remaining.get(p.event_product_id) ?? 0) - picked;
              // Out of stock on record doesn't block; adding to the cart asks for confirmation.
              const canAdd = chosen < required;
              return (
                <div key={p.event_product_id} className={`flex flex-col rounded-2xl border-2 ${picked ? "border-ube bg-ube-light" : "border-crust-dark bg-paper"}`}>
                  <button
                    type="button"
                    disabled={!canAdd}
                    onClick={() => change(p.event_product_id, 1)}
                    className="flex min-h-24 flex-1 flex-col items-start gap-1 rounded-t-2xl p-3 text-left active:scale-[0.97] disabled:opacity-50"
                    aria-label={`Add ${p.name}.${tracked ? ` ${Math.max(0, left)} left.` : ""} ${picked} picked.`}
                  >
                    <span className="font-bold leading-tight">{p.name}</span>
                    <span className="text-xs text-ink-soft">{formatPeso(p.price_centavos, { trimZeros: true })} each</span>
                    {tracked && <span className={`text-sm font-semibold ${left <= 0 ? "text-danger" : ""}`}>{left <= 0 ? "✕ Out of stock" : `${left} left`}</span>}
                  </button>
                  <div className="flex items-center justify-between border-t border-crust-dark px-2">
                    <button type="button" className="btn-ghost min-h-12 w-12 px-0 text-xl" disabled={!picked} onClick={() => change(p.event_product_id, -1)} aria-label={`Remove one ${p.name}`}>−</button>
                    <span className="text-xl font-black tabular-nums">{picked}</span>
                    <button type="button" className="btn-ghost min-h-12 w-12 px-0 text-xl" disabled={!canAdd} onClick={() => change(p.event_product_id, 1)} aria-label={`Add one ${p.name}`}>+</button>
                  </div>
                </div>
              );
            })}
          </div>
          <button
            className="btn-ube h-16 w-full text-xl"
            disabled={chosen !== required}
            onClick={() => {
              onAdd(Object.entries(picks).map(([eventProductId, quantity]) => ({ eventProductId, quantity })));
              setPicks({});
            }}
          >
            {chosen === required ? `Add to cart · ${formatPeso(bundle.price_centavos, { trimZeros: true })}` : `Pick ${required - chosen} more`}
          </button>
        </div>
      )}
    </Modal>
  );
}
