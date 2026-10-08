import type { Centavos } from "../money";

/** Shape returned by the pos_snapshot() RPC and cached on the tablet. */
export type Snapshot = {
  server_time: string;
  business: { id: string; name: string; timezone: string };
  staff: SnapshotStaff[];
  recent_qr_refs: string[];
  event: SnapshotEvent | null;
  products?: MenuProduct[];
  bundles?: MenuBundle[];
  voided_transaction_ids?: string[];
  /** Preset discounts set up by the owner (older servers don't send it) */
  discount_options?: DiscountOption[];
  /** This tablet's registration and the highest order sequence the server has seen per day */
  device?: SnapshotDevice | null;
};

export type SnapshotDevice = { id: string; code: string; label: string | null; order_counters: Record<string, number> };

/** Owner-defined preset discount. value: basis points for percent (1000 = 10%), centavos for fixed. */
export type DiscountOption = { id: string; name: string; type: "percent" | "fixed"; value: number };

export type SnapshotStaff = { id: string; name: string; role: "owner" | "staff"; pin_hash: string };

export type SnapshotEvent = {
  id: string;
  name: string;
  venue: string | null;
  status: "draft" | "live" | "closed";
  starts_on: string;
  ends_on: string;
  low_stock_threshold: number;
};

export type MenuProduct = {
  event_product_id: string;
  product_id: string;
  name: string;
  category: string;
  photo_url: string | null;
  price_centavos: Centavos;
  cost_centavos: Centavos;
  /** Live stock. In the snapshot this is the server's number; the POS overlays unsynced local changes. */
  stock: number;
  is_available: boolean;
  sort_order: number;
  sold_out_at: string | null;
  /** false: made to order, no stock kept (older servers don't send it: tracked) */
  track_stock?: boolean;
  /** Per-product low stock threshold; null/absent uses the event's */
  low_stock_threshold?: number | null;
};

export type MenuBundle = {
  event_bundle_id: string;
  bundle_id: string;
  name: string;
  type: "fixed" | "mix_match";
  photo_url: string | null;
  price_centavos: Centavos;
  required_count: number | null;
  is_available: boolean;
  sort_order: number;
  /** fixed: recipe (quantity per bundle). mix_match: eligible products (quantity ignored). */
  items: { product_id: string; event_product_id: string | null; quantity: number }[];
};

export type Menu = {
  eventId: string;
  lowStockThreshold: number;
  products: Map<string, MenuProduct>; // by event_product_id
  bundles: Map<string, MenuBundle>; // by event_bundle_id
};

export type Pick = { eventProductId: string; quantity: number };

export type CartLine =
  | { id: string; kind: "product"; eventProductId: string; quantity: number }
  | { id: string; kind: "bundle"; eventBundleId: string; quantity: number; /** mix_match only: picks for ONE bundle */ picks?: Pick[] };

export type Discount =
  | { type: "fixed"; value: Centavos; reason: string }
  | { type: "percent"; /** basis points: 1000 = 10% */ value: number; reason: string };

export type PricedComponent = {
  eventProductId: string;
  productId: string;
  name: string;
  quantity: number;
  regularUnitPrice: Centavos;
  unitCost: Centavos;
  allocatedRevenue: Centavos;
  allocatedDiscount: Centavos;
};

export type PricedLine = {
  line: CartLine;
  name: string;
  unitPrice: Centavos;
  lineTotal: Centavos;
  components: PricedComponent[];
};

export type PricedCart = {
  lines: PricedLine[];
  subtotal: Centavos;
  discount: Centavos;
  total: Centavos;
  itemCount: number;
};

export type PaymentPhoto = { bytes: ArrayBuffer; mime: string };

export type PaymentDetails =
  | { method: "cash"; cashReceived: Centavos }
  | { method: "qr_ph"; reference: string; photo?: PaymentPhoto | null };

/** JSON payload for the record_sale() RPC. Also what the tablet stores locally. */
export type SalePayload = {
  /** client_order_id: UUID v7 minted on the tablet, the idempotency key */
  id: string;
  /** {DEVICE_CODE}-{YYMMDD}-{SEQ}. Absent on sales made before order numbering. */
  order_number?: string;
  device_id?: string | null;
  event_id: string;
  staff_id: string;
  client_created_at: string;
  subtotal_centavos: Centavos;
  discount_type: "fixed" | "percent" | null;
  discount_value: number | null;
  discount_centavos: Centavos;
  discount_reason: string | null;
  total_centavos: Centavos;
  payment_method: "cash" | "qr_ph";
  qr_reference: string | null;
  cash_received_centavos: Centavos | null;
  change_given_centavos: Centavos | null;
  lines: SalePayloadLine[];
};

export type SalePayloadLine = {
  id: string;
  kind: "product" | "bundle";
  product_id: string | null;
  event_product_id: string | null;
  bundle_id: string | null;
  event_bundle_id: string | null;
  name_snapshot: string;
  quantity: number;
  unit_price_centavos: Centavos;
  line_total_centavos: Centavos;
  components: {
    event_product_id: string;
    product_id: string;
    quantity: number;
    regular_unit_price_centavos: Centavos;
    allocated_revenue_centavos: Centavos;
    allocated_discount_centavos: Centavos;
    unit_cost_centavos: Centavos;
  }[];
};
