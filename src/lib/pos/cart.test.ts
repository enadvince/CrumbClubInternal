import { describe, expect, it } from "vitest";
import {
  addBundle, addProduct, buildMenu, buildSale, bundleState, canIncrement, cartDemand, changeQuantity,
  priceCart, productState, pruneCart, remainingStock, saleStockEffects,
} from "./cart";
import { applySuggestion, suggestBundle } from "./suggest";
import { sampleSnapshot } from "./fixtures";
import type { CartLine, Menu } from "./types";

let n = 0;
const id = () => `line-${++n}`;
const menuWith = (stock: Record<string, number> = {}) => buildMenu(sampleSnapshot({ stock }))!;

describe("bundle stock", () => {
  it("selling a fixed bundle decrements each component, not a bundle stock", () => {
    const menu = menuWith();
    const cart = addBundle([], "eb-duo", id);
    const demand = cartDemand(cart, menu);
    expect(demand.get("ep-butter")).toBe(1);
    expect(demand.get("ep-choc")).toBe(1);
    const left = remainingStock(menu, addBundle(cart, "eb-duo", id));
    expect(left.get("ep-butter")).toBe(22);
    expect(left.get("ep-choc")).toBe(22);
  });

  it("mix-and-match decrements the picked items", () => {
    const menu = menuWith();
    const cart = addBundle([], "eb-any6", id, [{ eventProductId: "ep-ube", quantity: 4 }, { eventProductId: "ep-almond", quantity: 2 }]);
    const left = remainingStock(menu, cart);
    expect(left.get("ep-ube")).toBe(20);
    expect(left.get("ep-almond")).toBe(10);
    expect(left.get("ep-butter")).toBe(24);
  });

  it("sale stock effects cover every component", () => {
    const menu = menuWith();
    let cart: CartLine[] = addBundle([], "eb-ubebox", id);
    cart = addProduct(cart, "ep-ube", id);
    cart = addBundle(cart, "eb-duo", id);
    const sale = buildSale({ id: "s1", menu, priced: priceCart(cart, menu), discount: null, payment: { method: "cash", cashReceived: 200000 }, staffId: "st", createdAt: new Date() });
    const effects = Object.fromEntries(saleStockEffects(sale).map((e) => [e.eventProductId, e.delta]));
    expect(effects).toEqual({ "ep-ube": -7, "ep-butter": -1, "ep-choc": -1 });
  });
});

describe("availability", () => {
  it("fixed bundle unavailable when any component is sold out", () => {
    const menu = menuWith({ choc: 0 });
    const s = bundleState(menu, "eb-duo", remainingStock(menu, []));
    expect(s.canAdd).toBe(false);
    expect(s.status).toBe("sold_out");
  });

  it("fixed bundle unavailable when a component lacks enough for one more", () => {
    const menu = menuWith({ ube: 5 });
    expect(bundleState(menu, "eb-ubebox", remainingStock(menu, [])).canAdd).toBe(false);
    const menu6 = menuWith({ ube: 6 });
    expect(bundleState(menu6, "eb-ubebox", remainingStock(menu6, [])).canAdd).toBe(true);
    // ...and the cart counts: one box uses all 6
    const cart = addBundle([], "eb-ubebox", id);
    expect(bundleState(menu6, "eb-ubebox", remainingStock(menu6, cart)).status).toBe("in_cart");
  });

  it("fixed bundle unavailable when a component is marked unavailable", () => {
    const snap = sampleSnapshot();
    const menu = buildMenu(snap, undefined, new Map([["ep-butter", false]]))!;
    expect(bundleState(menu, "eb-duo", remainingStock(menu, [])).status).toBe("unavailable");
  });

  it("mix-and-match unavailable when fewer eligible items remain than required", () => {
    const menu = menuWith({ ensay: 1, tart: 1, cookie: 0 });
    expect(bundleState(menu, "eb-pick3", remainingStock(menu, [])).canAdd).toBe(false);
    const menu3 = menuWith({ ensay: 1, tart: 1, cookie: 1 });
    expect(bundleState(menu3, "eb-pick3", remainingStock(menu3, [])).canAdd).toBe(true);
    // A loose tart in the cart leaves only 2 eligible items
    const cart = addProduct([], "ep-tart", id);
    expect(bundleState(menu3, "eb-pick3", remainingStock(menu3, cart)).canAdd).toBe(false);
  });

  it("products: sold out, low, all-in-cart", () => {
    const menu = menuWith({ almond: 3, cookie: 0 });
    const rem = remainingStock(menu, []);
    expect(productState(menu, "ep-cookie", rem).status).toBe("sold_out");
    expect(productState(menu, "ep-almond", rem).status).toBe("low");
    const cart = [{ id: "x", kind: "product" as const, eventProductId: "ep-almond", quantity: 3 }];
    expect(productState(menu, "ep-almond", remainingStock(menu, cart)).status).toBe("in_cart");
  });

  it("canIncrement respects component stock", () => {
    const menu = menuWith({ ube: 12 });
    let cart: CartLine[] = addBundle([], "eb-ubebox", () => "box");
    expect(canIncrement(menu, cart, "box")).toBe(true);
    cart = changeQuantity(cart, "box", 1);
    expect(canIncrement(menu, cart, "box")).toBe(false);
  });
});

describe("pricing and revenue allocation", () => {
  const menu: Menu = menuWith();

  it("allocation sums exactly to the bundle price, proportional to regular prices", () => {
    const cart = addBundle([], "eb-duo", id); // ₱190 for butter ₱95 + choc ₱110
    const priced = priceCart(cart, menu);
    const comps = priced.lines[0].components;
    expect(comps.map((c) => c.allocatedRevenue)).toEqual([8805, 10195]);
    expect(comps.reduce((s, c) => s + c.allocatedRevenue, 0)).toBe(19000);
  });

  it("mix bundle with uneven split still sums exactly", () => {
    // ₱600 over 1 butter (95) + 2 ube (240) + 3 almond (390) = 725 regular
    const cart = addBundle([], "eb-any6", id, [
      { eventProductId: "ep-butter", quantity: 1 }, { eventProductId: "ep-ube", quantity: 2 }, { eventProductId: "ep-almond", quantity: 3 },
    ]);
    const priced = priceCart(changeQuantity(cart, cart[0].id, 1), menu); // 2 bundles = ₱1,200
    const sum = priced.lines[0].components.reduce((s, c) => s + c.allocatedRevenue, 0);
    expect(priced.lines[0].lineTotal).toBe(120000);
    expect(sum).toBe(120000);
  });

  it("transaction discount is allocated across all components and sums exactly", () => {
    let cart: CartLine[] = addBundle([], "eb-ubebox", id);
    cart = addProduct(cart, "ep-cookie", id);
    cart = addProduct(cart, "ep-cookie", id);
    const priced = priceCart(cart, menu, { type: "percent", value: 1000, reason: "Friend of the house" });
    expect(priced.subtotal).toBe(65000 + 13000);
    expect(priced.discount).toBe(7800);
    expect(priced.total).toBe(70200);
    const all = priced.lines.flatMap((l) => l.components);
    expect(all.reduce((s, c) => s + c.allocatedDiscount, 0)).toBe(7800);
    expect(all.reduce((s, c) => s + c.allocatedRevenue - c.allocatedDiscount, 0)).toBe(priced.total);
  });

  it("fixed discount never exceeds subtotal", () => {
    const priced = priceCart(addProduct([], "ep-cookie", id), menu, { type: "fixed", value: 999999, reason: "x" });
    expect(priced.total).toBe(0);
  });

  it("percentage discount rounds half-up in centavos", () => {
    const priced = priceCart(addProduct([], "ep-butter", id), menu, { type: "percent", value: 1050, reason: "x" });
    expect(priced.discount).toBe(998); // 10.5% of 9500 = 997.5
  });

  it("buildSale validates payment and computes change", () => {
    const cart = addProduct([], "ep-butter", id);
    const priced = priceCart(cart, menu);
    const sale = buildSale({ id: "s", menu, priced, discount: null, payment: { method: "cash", cashReceived: 10000 }, staffId: "st", createdAt: new Date() });
    expect(sale.change_given_centavos).toBe(500);
    expect(() => buildSale({ id: "s", menu, priced, discount: null, payment: { method: "cash", cashReceived: 9000 }, staffId: "st", createdAt: new Date() })).toThrow();
    expect(() => buildSale({ id: "s", menu, priced, discount: null, payment: { method: "qr_ph", reference: " " }, staffId: "st", createdAt: new Date() })).toThrow();
    const pricedDisc = priceCart(cart, menu, { type: "fixed", value: 500, reason: "" });
    expect(() => buildSale({ id: "s", menu, priced: pricedDisc, discount: { type: "fixed", value: 500, reason: "" }, payment: { method: "cash", cashReceived: 10000 }, staffId: "st", createdAt: new Date() })).toThrow(/reason/);
  });

  it("sale payload: lines sum to subtotal, components sum to lines", () => {
    let cart: CartLine[] = addBundle([], "eb-any6", id, [{ eventProductId: "ep-ube", quantity: 3 }, { eventProductId: "ep-almond", quantity: 3 }]);
    cart = addProduct(cart, "ep-tart", id);
    const discount = { type: "fixed" as const, value: 1234, reason: "Loyalty" };
    const sale = buildSale({ id: "s", menu, priced: priceCart(cart, menu, discount), discount, payment: { method: "qr_ph", reference: "1234567890123" }, staffId: "st", createdAt: new Date() });
    expect(sale.lines.reduce((s, l) => s + l.line_total_centavos, 0)).toBe(sale.subtotal_centavos);
    for (const l of sale.lines) expect(l.components.reduce((s, c) => s + c.allocated_revenue_centavos, 0)).toBe(l.line_total_centavos);
    expect(sale.lines.flatMap((l) => l.components).reduce((s, c) => s + c.allocated_discount_centavos, 0)).toBe(1234);
    expect(sale.total_centavos).toBe(sale.subtotal_centavos - 1234);
  });
});

describe("cart mutations", () => {
  it("tap again increases quantity", () => {
    let cart: CartLine[] = addProduct([], "ep-ube", id);
    cart = addProduct(cart, "ep-ube", id);
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(2);
  });

  it("identical mix picks merge, different picks don't", () => {
    const a = [{ eventProductId: "ep-ube", quantity: 6 }];
    let cart = addBundle([], "eb-any6", id, a);
    cart = addBundle(cart, "eb-any6", id, [...a]);
    expect(cart).toHaveLength(1);
    cart = addBundle(cart, "eb-any6", id, [{ eventProductId: "ep-butter", quantity: 6 }]);
    expect(cart).toHaveLength(2);
  });

  it("minus to zero removes the line", () => {
    const cart = addProduct([], "ep-ube", () => "l");
    expect(changeQuantity(cart, "l", -1)).toEqual([]);
  });

  it("prunes lines no longer on the menu", () => {
    const snap = sampleSnapshot();
    snap.products = snap.products!.filter((p) => p.event_product_id !== "ep-choc");
    const menu = buildMenu(snap)!;
    const cart: CartLine[] = [
      { id: "a", kind: "product", eventProductId: "ep-choc", quantity: 1 },
      { id: "b", kind: "bundle", eventBundleId: "eb-duo", quantity: 1 },
      { id: "c", kind: "product", eventProductId: "ep-ube", quantity: 1 },
    ];
    expect(pruneCart(cart, menu).map((l) => l.id)).toEqual(["c"]);
  });
});

describe("bundle suggestions", () => {
  const menu = menuWith();

  it("suggests a fixed bundle when loose items match and it's cheaper", () => {
    let cart: CartLine[] = [];
    for (let i = 0; i < 6; i++) cart = addProduct(cart, "ep-ube", id);
    const s = suggestBundle(cart, menu)!;
    // 6 ube = ₱720. Ube Box ₱650 saves ₱70; Any 6 ₱600 saves ₱120 → best
    expect(s.name).toBe("Any 6 Croissants");
    expect(s.savings).toBe(12000);
    const next = applySuggestion(cart, s, id);
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("bundle");
    expect(priceCart(next, menu).total).toBe(60000);
  });

  it("suggests Breakfast Duo for a butter + pain au chocolat", () => {
    let cart: CartLine[] = addProduct([], "ep-butter", id);
    cart = addProduct(cart, "ep-choc", id);
    cart = addProduct(cart, "ep-cookie", id);
    const s = suggestBundle(cart, menu)!;
    expect(s.name).toBe("Breakfast Duo");
    expect(s.savings).toBe(1500);
    const next = applySuggestion(cart, s, id);
    expect(next.map((l) => l.kind).sort()).toEqual(["bundle", "product"]);
  });

  it("no suggestion when the bundle isn't cheaper or items don't match", () => {
    expect(suggestBundle(addProduct([], "ep-ube", id), menu)).toBeNull();
    let cart: CartLine[] = [];
    for (let i = 0; i < 3; i++) cart = addProduct(cart, "ep-cookie", id);
    // 3 cookies = ₱195 < Pick 3 at ₱210 → no saving
    expect(suggestBundle(cart, menu)).toBeNull();
  });

  it("mix suggestion picks the most expensive eligible items", () => {
    let cart: CartLine[] = [];
    for (const ep of ["ep-tart", "ep-tart", "ep-ensay", "ep-cookie"]) cart = addProduct(cart, ep, id);
    const s = suggestBundle(cart, menu)!;
    expect(s.name).toBe("Pick 3 Treats");
    expect(s.savings).toBe(9000 + 9000 + 8500 - 21000);
    const next = applySuggestion(cart, s, id);
    const left = next.filter((l) => l.kind === "product");
    expect(left).toEqual([expect.objectContaining({ eventProductId: "ep-cookie", quantity: 1 })]);
  });
});
