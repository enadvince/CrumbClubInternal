import { allocate } from "./allocate";
import { percentOf, type Centavos } from "../money";
import type {
  CartLine, Discount, Menu, MenuBundle, MenuProduct, PaymentDetails, Pick, PricedCart, PricedComponent,
  PricedLine, SalePayload, Snapshot,
} from "./types";

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/** Builds the lookup structure from a snapshot, with live stock overridden by `stock`. */
export function buildMenu(snapshot: Snapshot, stock?: ReadonlyMap<string, number>, availability?: ReadonlyMap<string, boolean>): Menu | null {
  if (!snapshot.event) return null;
  const products = new Map<string, MenuProduct>();
  for (const p of snapshot.products ?? []) {
    products.set(p.event_product_id, {
      ...p,
      stock: stock?.get(p.event_product_id) ?? p.stock,
      is_available: availability?.get(p.event_product_id) ?? p.is_available,
    });
  }
  const bundles = new Map<string, MenuBundle>();
  for (const b of snapshot.bundles ?? []) bundles.set(b.event_bundle_id, b);
  return { eventId: snapshot.event.id, lowStockThreshold: snapshot.event.low_stock_threshold, products, bundles };
}

// ---------------------------------------------------------------------------
// Components and stock demand
// ---------------------------------------------------------------------------

/** Products physically handed over for a cart line, aggregated per event product. */
export function lineComponents(line: CartLine, menu: Menu): Pick[] {
  const out = new Map<string, number>();
  const add = (ep: string, qty: number) => out.set(ep, (out.get(ep) ?? 0) + qty);
  if (line.kind === "product") {
    add(line.eventProductId, line.quantity);
  } else {
    const bundle = menu.bundles.get(line.eventBundleId);
    if (!bundle) throw new Error(`Unknown bundle ${line.eventBundleId}`);
    if (bundle.type === "fixed") {
      for (const item of bundle.items) {
        if (!item.event_product_id) throw new Error(`${bundle.name} contains a product that is not on this menu`);
        add(item.event_product_id, item.quantity * line.quantity);
      }
    } else {
      for (const pick of line.picks ?? []) add(pick.eventProductId, pick.quantity * line.quantity);
    }
  }
  return [...out.entries()].map(([eventProductId, quantity]) => ({ eventProductId, quantity }));
}

/** Total units of each event product the cart would consume. */
export function cartDemand(cart: readonly CartLine[], menu: Menu): Map<string, number> {
  const demand = new Map<string, number>();
  for (const line of cart) {
    for (const c of lineComponents(line, menu)) demand.set(c.eventProductId, (demand.get(c.eventProductId) ?? 0) + c.quantity);
  }
  return demand;
}

export const isTracked = (p: MenuProduct | undefined): boolean => p?.track_stock !== false;

/** Low stock threshold for a product: its own, or the event's default. */
export const lowThreshold = (menu: Menu, p: MenuProduct): number => p.low_stock_threshold ?? menu.lowStockThreshold;

/**
 * Stock left for each product after what's already in the cart. Products without
 * stock tracking (made to order) never run out: Infinity.
 */
export function remainingStock(menu: Menu, cart: readonly CartLine[]): Map<string, number> {
  const demand = cartDemand(cart, menu);
  const remaining = new Map<string, number>();
  for (const [id, p] of menu.products) remaining.set(id, isTracked(p) ? p.stock - (demand.get(id) ?? 0) : Infinity);
  return remaining;
}

// ---------------------------------------------------------------------------
// Availability. Low or out of stock never blocks a sale (the count on record may be
// wrong); only items an owner marked unavailable can't be added. Adding something
// that would go below zero asks for confirmation first (see addWouldOversell).
// ---------------------------------------------------------------------------

export type ItemState = {
  /** false only when an owner marked it unavailable */
  canAdd: boolean;
  /** Units left after the cart (products) / how many more bundles fit (fixed) / pickable pool (mix). Infinity if untracked. */
  remaining: number;
  status: "ok" | "low" | "out" | "unavailable";
};

export function productState(menu: Menu, eventProductId: string, remaining: ReadonlyMap<string, number>): ItemState {
  const p = menu.products.get(eventProductId);
  if (!p || !p.is_available) return { canAdd: false, remaining: 0, status: "unavailable" };
  if (!isTracked(p)) return { canAdd: true, remaining: Infinity, status: "ok" };
  const left = remaining.get(eventProductId) ?? 0;
  if (left <= 0) return { canAdd: true, remaining: 0, status: "out" };
  return { canAdd: true, remaining: left, status: left <= lowThreshold(menu, p) ? "low" : "ok" };
}

/**
 * Fixed bundle: how many more fit given every tracked component's stock.
 * Mix-and-match: the eligible products still in stock must add up to the required count.
 */
export function bundleState(menu: Menu, eventBundleId: string, remaining: ReadonlyMap<string, number>): ItemState {
  const b = menu.bundles.get(eventBundleId);
  if (!b || !b.is_available) return { canAdd: false, remaining: 0, status: "unavailable" };

  if (b.type === "fixed") {
    if (b.items.length === 0) return { canAdd: false, remaining: 0, status: "unavailable" };
    let fits = Infinity;
    for (const item of b.items) {
      const p = item.event_product_id ? menu.products.get(item.event_product_id) : undefined;
      if (!p || !p.is_available) return { canAdd: false, remaining: 0, status: "unavailable" };
      if (!isTracked(p)) continue;
      fits = Math.min(fits, Math.floor(Math.max(0, remaining.get(p.event_product_id) ?? 0) / item.quantity));
    }
    if (fits <= 0) return { canAdd: true, remaining: 0, status: "out" };
    return { canAdd: true, remaining: fits, status: fits <= Math.max(1, Math.floor(menu.lowStockThreshold / 2)) ? "low" : "ok" };
  }

  const required = b.required_count ?? 1;
  let pool = 0;
  for (const p of eligibleProducts(menu, b)) pool += isTracked(p) ? Math.max(0, remaining.get(p.event_product_id) ?? 0) : Infinity;
  if (pool < required) return { canAdd: true, remaining: 0, status: "out" };
  const fits = Math.floor(pool / required);
  return { canAdd: true, remaining: fits, status: fits <= 1 ? "low" : "ok" };
}

/** Eligible products for a mix-and-match bundle that are on this menu and available. */
export function eligibleProducts(menu: Menu, bundle: MenuBundle): MenuProduct[] {
  return bundle.items
    .map((i) => (i.event_product_id ? menu.products.get(i.event_product_id) : undefined))
    .filter((p): p is MenuProduct => !!p && p.is_available)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

/** Tracked products a new line would take below zero (empty: fine to add without asking). */
export function addWouldOversell(menu: Menu, cart: readonly CartLine[], line: CartLine): MenuProduct[] {
  const remaining = remainingStock(menu, cart);
  const short: MenuProduct[] = [];
  for (const c of lineComponents(line, menu)) {
    const p = menu.products.get(c.eventProductId);
    if (p && isTracked(p) && (remaining.get(c.eventProductId) ?? 0) < c.quantity) short.push(p);
  }
  return short;
}

/** Whether a cart line's + button can be used (only unavailable items are blocked). */
export function canIncrement(menu: Menu, cart: readonly CartLine[], lineId: string): boolean {
  const line = cart.find((l) => l.id === lineId);
  if (!line) return false;
  if (line.kind === "bundle" && !menu.bundles.get(line.eventBundleId)?.is_available) return false;
  return lineComponents({ ...line, quantity: 1 }, menu).every((c) => menu.products.get(c.eventProductId)?.is_available);
}

/** Tracked products one more of this line would take below zero. */
export function incrementWouldOversell(menu: Menu, cart: readonly CartLine[], lineId: string): MenuProduct[] {
  const line = cart.find((l) => l.id === lineId);
  return line ? addWouldOversell(menu, cart, { ...line, quantity: 1 }) : [];
}

// ---------------------------------------------------------------------------
// Cart mutations (pure)
// ---------------------------------------------------------------------------

const samePicks = (a: Pick[] = [], b: Pick[] = []) => {
  const key = (p: Pick[]) => [...p].sort((x, y) => x.eventProductId.localeCompare(y.eventProductId)).map((x) => `${x.eventProductId}:${x.quantity}`).join("|");
  return key(a) === key(b);
};

export function addProduct(cart: readonly CartLine[], eventProductId: string, newId: () => string): CartLine[] {
  const existing = cart.find((l) => l.kind === "product" && l.eventProductId === eventProductId);
  if (existing) return cart.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l));
  return [...cart, { id: newId(), kind: "product", eventProductId, quantity: 1 }];
}

export function addBundle(cart: readonly CartLine[], eventBundleId: string, newId: () => string, picks?: Pick[]): CartLine[] {
  const existing = cart.find((l) => l.kind === "bundle" && l.eventBundleId === eventBundleId && samePicks(l.picks, picks));
  if (existing) return cart.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l));
  return [...cart, { id: newId(), kind: "bundle", eventBundleId, quantity: 1, ...(picks ? { picks } : {}) }];
}

export function changeQuantity(cart: readonly CartLine[], lineId: string, delta: number): CartLine[] {
  return cart
    .map((l) => (l.id === lineId ? { ...l, quantity: l.quantity + delta } : l))
    .filter((l) => l.quantity > 0);
}

/** Drops lines whose items are no longer on the menu (e.g. after a menu refresh). */
export function pruneCart(cart: readonly CartLine[], menu: Menu): CartLine[] {
  return cart.filter((l) => {
    try {
      if (l.kind === "bundle" && !menu.bundles.has(l.eventBundleId)) return false;
      return lineComponents(l, menu).every((c) => menu.products.has(c.eventProductId));
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Pricing and revenue allocation
// ---------------------------------------------------------------------------

export function discountAmount(subtotal: Centavos, discount: Discount | null): Centavos {
  if (!discount) return 0;
  const raw = discount.type === "fixed" ? discount.value : percentOf(subtotal, discount.value);
  return Math.max(0, Math.min(subtotal, raw));
}

/**
 * Prices the cart. Bundle prices are split across their components in
 * proportion to the components' regular (event) prices; the transaction
 * discount is then split across every component in proportion to its
 * allocated revenue. Both splits sum exactly (largest remainder).
 */
export function priceCart(cart: readonly CartLine[], menu: Menu, discount: Discount | null = null): PricedCart {
  const lines: PricedLine[] = cart.map((line) => {
    const comps = lineComponents(line, menu).map((c) => {
      const p = menu.products.get(c.eventProductId);
      if (!p) throw new Error(`Unknown product ${c.eventProductId}`);
      return { p, quantity: c.quantity };
    });
    let name: string;
    let unitPrice: Centavos;
    if (line.kind === "product") {
      const p = menu.products.get(line.eventProductId)!;
      name = p.name;
      unitPrice = p.price_centavos;
    } else {
      const b = menu.bundles.get(line.eventBundleId)!;
      name = b.name;
      unitPrice = b.price_centavos;
    }
    const lineTotal = unitPrice * line.quantity;
    const shares = allocate(lineTotal, comps.map(({ p, quantity }) => p.price_centavos * quantity));
    const components: PricedComponent[] = comps.map(({ p, quantity }, i) => ({
      eventProductId: p.event_product_id,
      productId: p.product_id,
      name: p.name,
      quantity,
      regularUnitPrice: p.price_centavos,
      unitCost: p.cost_centavos,
      allocatedRevenue: shares[i],
      allocatedDiscount: 0,
    }));
    return { line, name, unitPrice, lineTotal, components };
  });

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const discountTotal = discountAmount(subtotal, discount);
  const all = lines.flatMap((l) => l.components);
  if (all.length > 0) {
    const discountShares = allocate(discountTotal, all.map((c) => c.allocatedRevenue));
    all.forEach((c, i) => (c.allocatedDiscount = discountShares[i]));
  }
  return {
    lines,
    subtotal,
    discount: discountTotal,
    total: subtotal - discountTotal,
    itemCount: all.reduce((s, c) => s + c.quantity, 0),
  };
}

export function changeDue(total: Centavos, cashReceived: Centavos): Centavos {
  return cashReceived - total;
}

/** Builds the record_sale() payload. Throws if payment details are invalid. */
export function buildSale(args: {
  id: string;
  menu: Menu;
  priced: PricedCart;
  discount: Discount | null;
  payment: PaymentDetails;
  staffId: string;
  createdAt: Date;
}): SalePayload {
  const { priced, discount, payment, menu } = args;
  if (priced.lines.length === 0) throw new Error("Cart is empty");
  if (priced.discount > 0 && !discount?.reason.trim()) throw new Error("A discount needs a reason");
  if (payment.method === "cash" && payment.cashReceived < priced.total) throw new Error("Cash received is less than the total");
  if (payment.method === "qr_ph" && !payment.reference.trim()) throw new Error("Enter the QR Ph reference number");

  return {
    id: args.id,
    event_id: menu.eventId,
    staff_id: args.staffId,
    client_created_at: args.createdAt.toISOString(),
    subtotal_centavos: priced.subtotal,
    discount_type: priced.discount > 0 ? discount!.type : null,
    discount_value: priced.discount > 0 ? discount!.value : null,
    discount_centavos: priced.discount,
    discount_reason: priced.discount > 0 ? discount!.reason.trim() : null,
    total_centavos: priced.total,
    payment_method: payment.method,
    qr_reference: payment.method === "qr_ph" ? payment.reference.trim() : null,
    cash_received_centavos: payment.method === "cash" ? payment.cashReceived : null,
    change_given_centavos: payment.method === "cash" ? payment.cashReceived - priced.total : null,
    lines: priced.lines.map((l) => {
      const isBundle = l.line.kind === "bundle";
      const product = l.line.kind === "product" ? menu.products.get(l.line.eventProductId)! : null;
      const bundle = l.line.kind === "bundle" ? menu.bundles.get(l.line.eventBundleId)! : null;
      return {
        id: l.line.id,
        kind: l.line.kind,
        product_id: product?.product_id ?? null,
        event_product_id: product?.event_product_id ?? null,
        bundle_id: isBundle ? bundle!.bundle_id : null,
        event_bundle_id: isBundle ? bundle!.event_bundle_id : null,
        name_snapshot: l.name,
        quantity: l.line.quantity,
        unit_price_centavos: l.unitPrice,
        line_total_centavos: l.lineTotal,
        components: l.components.map((c) => ({
          event_product_id: c.eventProductId,
          product_id: c.productId,
          quantity: c.quantity,
          regular_unit_price_centavos: c.regularUnitPrice,
          allocated_revenue_centavos: c.allocatedRevenue,
          allocated_discount_centavos: c.allocatedDiscount,
          unit_cost_centavos: c.unitCost,
        })),
      };
    }),
  };
}

/** Stock deltas a sale causes (negative), keyed by event product. */
export function saleStockEffects(sale: SalePayload): { eventProductId: string; delta: number }[] {
  const out = new Map<string, number>();
  for (const line of sale.lines) {
    for (const c of line.components) out.set(c.event_product_id, (out.get(c.event_product_id) ?? 0) - c.quantity);
  }
  return [...out.entries()].map(([eventProductId, delta]) => ({ eventProductId, delta }));
}
