/** Row shapes as returned by Supabase (subset of columns the UI uses). */
export type ProductRow = {
  id: string; business_id: string; name: string; category: string; photo_url: string | null;
  default_price_centavos: number; cost_centavos: number; active: boolean;
};

export type BundleRow = {
  id: string; business_id: string; name: string; photo_url: string | null;
  type: "fixed" | "mix_match"; price_centavos: number; required_count: number | null; active: boolean;
  bundle_items: { id?: string; product_id: string; quantity: number }[];
};

export type EventStatus = "draft" | "live" | "closed";

export type EventRow = {
  id: string; business_id: string; name: string; venue: string | null; starts_on: string; ends_on: string;
  status: EventStatus; low_stock_threshold: number; went_live_at: string | null; closed_at: string | null; created_at: string;
};

export type EventProductRow = {
  id: string; event_id: string; product_id: string; price_centavos: number; starting_stock: number;
  current_stock: number; sold_out_at: string | null; is_available: boolean; sort_order: number;
  closing_stock: number | null; closing_unit_cost: number | null;
};

export type EventBundleRow = {
  id: string; event_id: string; bundle_id: string; price_centavos: number; is_available: boolean; sort_order: number;
};
