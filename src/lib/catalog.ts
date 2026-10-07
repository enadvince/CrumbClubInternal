import type { Centavos } from "./money";

export type CatalogProduct = { id: string; name: string; price: Centavos; cost: Centavos };

export type FixedBundleItem = { productId: string; quantity: number };

export type BundleScenario = {
  label: string;
  /** What the same items cost bought one by one at regular prices */
  separatePrice: Centavos;
  cost: Centavos;
  bundleMargin: Centavos;
  separateMargin: Centavos;
  /** separatePrice − bundle price (positive = customer saves) */
  discount: Centavos;
  bundleMarginPerPiece: number;
  separateMarginPerPiece: number;
  pieces: number;
};

function scenario(label: string, bundlePrice: Centavos, lines: { product: CatalogProduct; quantity: number }[]): BundleScenario {
  let separatePrice = 0;
  let cost = 0;
  let pieces = 0;
  for (const { product, quantity } of lines) {
    separatePrice += product.price * quantity;
    cost += product.cost * quantity;
    pieces += quantity;
  }
  return {
    label,
    separatePrice,
    cost,
    bundleMargin: bundlePrice - cost,
    separateMargin: separatePrice - cost,
    discount: separatePrice - bundlePrice,
    bundleMarginPerPiece: pieces ? (bundlePrice - cost) / pieces : 0,
    separateMarginPerPiece: pieces ? (separatePrice - cost) / pieces : 0,
    pieces,
  };
}

/** Economics of a fixed bundle vs. buying its contents separately. */
export function fixedBundleEconomics(
  bundlePrice: Centavos,
  items: readonly FixedBundleItem[],
  products: ReadonlyMap<string, CatalogProduct>,
): BundleScenario | null {
  const lines = items.flatMap((i) => {
    const product = products.get(i.productId);
    return product && i.quantity > 0 ? [{ product, quantity: i.quantity }] : [];
  });
  if (lines.length === 0) return null;
  return scenario("Bundle", bundlePrice, lines);
}

/**
 * Mix-and-match margin depends on what's picked. Returns the two extremes:
 * every pick is the cheapest-to-make item (best margin) or the most expensive
 * one (worst margin), allowing repeats.
 */
export function mixBundleEconomics(
  bundlePrice: Centavos,
  requiredCount: number,
  eligibleIds: readonly string[],
  products: ReadonlyMap<string, CatalogProduct>,
): { best: BundleScenario; worst: BundleScenario } | null {
  const eligible = eligibleIds.map((id) => products.get(id)).filter((p): p is CatalogProduct => !!p);
  if (eligible.length === 0 || requiredCount <= 0) return null;
  const byMargin = [...eligible].sort((a, b) => (bundlePrice - a.cost) - (bundlePrice - b.cost) || a.price - b.price);
  const worstPick = byMargin[0]; // highest cost
  const bestPick = byMargin[byMargin.length - 1]; // lowest cost
  return {
    best: scenario(`All ${bestPick.name}`, bundlePrice, [{ product: bestPick, quantity: requiredCount }]),
    worst: scenario(`All ${worstPick.name}`, bundlePrice, [{ product: worstPick, quantity: requiredCount }]),
  };
}
