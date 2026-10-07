import { addBundle, eligibleProducts } from "./cart";
import type { CartLine, Menu, Pick } from "./types";
import type { Centavos } from "../money";

export type BundleSuggestion = {
  eventBundleId: string;
  name: string;
  savings: Centavos;
  /** Loose units the bundle replaces */
  take: Pick[];
  /** mix_match only */
  picks?: Pick[];
};

/**
 * If the cart's loose (single) items could be swapped for one bundle that is
 * cheaper, returns the swap that saves the customer the most. Converting loose
 * items into a bundle uses the same stock, so stock never blocks a suggestion.
 */
export function suggestBundle(cart: readonly CartLine[], menu: Menu): BundleSuggestion | null {
  const loose = new Map<string, number>();
  for (const l of cart) if (l.kind === "product") loose.set(l.eventProductId, (loose.get(l.eventProductId) ?? 0) + l.quantity);
  if (loose.size === 0) return null;

  let best: BundleSuggestion | null = null;
  for (const b of menu.bundles.values()) {
    if (!b.is_available) continue;
    let candidate: BundleSuggestion | null = null;

    if (b.type === "fixed") {
      if (b.items.length === 0) continue;
      let separate = 0;
      let fits = true;
      for (const item of b.items) {
        const p = item.event_product_id ? menu.products.get(item.event_product_id) : undefined;
        if (!p || !p.is_available || (loose.get(p.event_product_id) ?? 0) < item.quantity) { fits = false; break; }
        separate += p.price_centavos * item.quantity;
      }
      if (fits && separate > b.price_centavos) {
        candidate = {
          eventBundleId: b.event_bundle_id,
          name: b.name,
          savings: separate - b.price_centavos,
          take: b.items.map((i) => ({ eventProductId: i.event_product_id!, quantity: i.quantity })),
        };
      }
    } else {
      const required = b.required_count ?? 0;
      if (required <= 0) continue;
      // Use the most expensive eligible loose items: that maximises the saving.
      const units = eligibleProducts(menu, b)
        .flatMap((p) => Array.from({ length: loose.get(p.event_product_id) ?? 0 }, () => p))
        .sort((x, y) => y.price_centavos - x.price_centavos);
      if (units.length < required) continue;
      const chosen = units.slice(0, required);
      const separate = chosen.reduce((s, p) => s + p.price_centavos, 0);
      if (separate > b.price_centavos) {
        const counts = new Map<string, number>();
        for (const p of chosen) counts.set(p.event_product_id, (counts.get(p.event_product_id) ?? 0) + 1);
        const picks = [...counts.entries()].map(([eventProductId, quantity]) => ({ eventProductId, quantity }));
        candidate = { eventBundleId: b.event_bundle_id, name: b.name, savings: separate - b.price_centavos, take: picks, picks };
      }
    }

    if (candidate && (!best || candidate.savings > best.savings)) best = candidate;
  }
  return best;
}

/** Replaces the loose items with the suggested bundle. */
export function applySuggestion(cart: readonly CartLine[], s: BundleSuggestion, newId: () => string): CartLine[] {
  const toRemove = new Map(s.take.map((t) => [t.eventProductId, t.quantity]));
  const next: CartLine[] = [];
  for (const l of cart) {
    if (l.kind === "product" && toRemove.has(l.eventProductId)) {
      const remove = Math.min(l.quantity, toRemove.get(l.eventProductId)!);
      toRemove.set(l.eventProductId, toRemove.get(l.eventProductId)! - remove);
      if (l.quantity - remove > 0) next.push({ ...l, quantity: l.quantity - remove });
    } else {
      next.push(l);
    }
  }
  return addBundle(next, s.eventBundleId, newId, s.picks);
}
