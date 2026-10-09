import type { MenuBundle, MenuProduct, Snapshot } from "./types";

/** Test/demo menu mirroring the seeded sample data. */
export function sampleSnapshot(overrides: { stock?: Record<string, number> } = {}): Snapshot {
  const product = (id: string, name: string, price: number, cost: number, stock: number, sort: number, category = "Croissants"): MenuProduct => ({
    event_product_id: `ep-${id}`, product_id: `p-${id}`, name, category, photo_url: null,
    price_centavos: price, cost_centavos: cost, stock: overrides.stock?.[id] ?? stock, is_available: true,
    sort_order: sort, sold_out_at: null,
  });
  const products = [
    product("butter", "Butter Croissant", 9500, 3800, 24, 1),
    product("ube", "Ube Croissant", 12000, 5000, 24, 2),
    product("choc", "Pain au Chocolat", 11000, 4500, 24, 3),
    product("almond", "Almond Croissant", 13000, 5500, 12, 4),
    product("ensay", "Ensaymada", 8500, 3000, 24, 5, "Breads"),
    product("tart", "Calamansi Tart", 9000, 3500, 24, 6, "Sweets"),
    product("cookie", "Brown Butter Cookie", 6500, 2200, 24, 7, "Sweets"),
  ];
  const bundle = (id: string, name: string, type: "fixed" | "mix_match", price: number, items: [string, number][], required: number | null, sort: number): MenuBundle => ({
    event_bundle_id: `eb-${id}`, bundle_id: `b-${id}`, name, type, photo_url: null, price_centavos: price,
    required_count: required, is_available: true, sort_order: sort,
    items: items.map(([pid, quantity]) => ({ product_id: `p-${pid}`, event_product_id: `ep-${pid}`, quantity })),
  });
  return {
    server_time: "2026-10-10T00:00:00Z",
    business: { id: "biz", name: "Crumb Club", timezone: "Asia/Manila" },
    device: { id: "device-1", code: "T1", label: "Counter tablet", order_counters: {} },
    staff: [],
    recent_qr_refs: [],
    discount_options: [{ id: "d-senior", name: "Senior citizen", type: "percent", value: 2000 }],
    event: { id: "event-1", name: "Sample Market", venue: "Salcedo", status: "live", starts_on: "2026-10-10", ends_on: "2026-10-10", low_stock_threshold: 5 },
    products,
    bundles: [
      bundle("ubebox", "Ube Box (6)", "fixed", 65000, [["ube", 6]], null, 1),
      bundle("duo", "Breakfast Duo", "fixed", 19000, [["butter", 1], ["choc", 1]], null, 2),
      bundle("any6", "Any 6 Croissants", "mix_match", 60000, [["butter", 1], ["ube", 1], ["choc", 1], ["almond", 1]], 6, 3),
      bundle("pick3", "Pick 3 Treats", "mix_match", 21000, [["ensay", 1], ["tart", 1], ["cookie", 1]], 3, 4),
    ],
    voided_transaction_ids: [],
  };
}
