-- Crumb Club POS — core schema
-- Money: bigint centavos everywhere. Times: timestamptz (reported in Asia/Manila).
-- Every business-owned table carries business_id so RLS can scope it.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('owner', 'device');
create type public.staff_role as enum ('owner', 'staff');
create type public.bundle_type as enum ('fixed', 'mix_match');
create type public.event_status as enum ('draft', 'live', 'closed');
create type public.payment_method as enum ('cash', 'qr_ph');
create type public.txn_status as enum ('completed', 'voided');
create type public.discount_type as enum ('fixed', 'percent');
create type public.line_kind as enum ('product', 'bundle');
create type public.adjustment_reason as enum (
  'restock', 'waste', 'staff_meal', 'giveaway', 'correction'
);

-- ---------------------------------------------------------------------------
-- Tenancy and identity
-- ---------------------------------------------------------------------------
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  timezone text not null default 'Asia/Manila',
  created_at timestamptz not null default now()
);

-- Links a Supabase Auth user to a business. 'owner' = a person who logs in
-- with email/password. 'device' = the paired POS tablet's login.
create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  role public.member_role not null,
  label text,
  created_at timestamptz not null default now(),
  primary key (user_id, business_id)
);
create index memberships_business_idx on public.memberships (business_id);

-- People who ring up sales. PINs are 4 digits, bcrypt-hashed (pgcrypto 'bf').
-- Owners get a staff row too (linked via user_id) so their sales are attributed.
create table public.staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  role public.staff_role not null default 'staff',
  pin_hash text,
  user_id uuid references auth.users (id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index staff_business_idx on public.staff (business_id);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  category text not null default 'Pastries',
  photo_url text,
  default_price_centavos bigint not null check (default_price_centavos >= 0),
  cost_centavos bigint not null check (cost_centavos >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_business_idx on public.products (business_id);

create table public.bundles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  photo_url text,
  type public.bundle_type not null,
  price_centavos bigint not null check (price_centavos >= 0),
  -- mix_match only: how many items the customer picks
  required_count int,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bundles_required_count_chk check (
    (type = 'fixed' and required_count is null)
    or (type = 'mix_match' and required_count is not null and required_count > 0)
  )
);
create index bundles_business_idx on public.bundles (business_id);

-- fixed: (product, quantity) recipe rows. mix_match: eligible products (quantity ignored, 1).
create table public.bundle_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  bundle_id uuid not null references public.bundles (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  quantity int not null default 1 check (quantity > 0),
  unique (bundle_id, product_id)
);
create index bundle_items_bundle_idx on public.bundle_items (bundle_id);

-- ---------------------------------------------------------------------------
-- Events (a pop-up / selling day or multi-day run)
-- ---------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  venue text,
  starts_on date not null,
  ends_on date not null,
  status public.event_status not null default 'draft',
  low_stock_threshold int not null default 5 check (low_stock_threshold >= 0),
  went_live_at timestamptz,
  closed_at timestamptz,
  closed_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index events_business_idx on public.events (business_id, starts_on desc);
-- One live event per business keeps the tablet unambiguous.
create unique index events_one_live_per_business on public.events (business_id) where status = 'live';

create table public.event_products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  price_centavos bigint not null check (price_centavos >= 0),
  starting_stock int not null default 0 check (starting_stock >= 0),
  -- Cache maintained by triggers: starting + adjustments − sold (completed sales).
  current_stock int not null default 0,
  sold_out_at timestamptz,
  is_available boolean not null default true,
  sort_order int not null default 0,
  -- Snapshots taken when the event closes (leftover valuation).
  closing_stock int,
  closing_unit_cost bigint,
  unique (event_id, product_id)
);
create index event_products_event_idx on public.event_products (event_id);

create table public.event_bundles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  bundle_id uuid not null references public.bundles (id) on delete restrict,
  price_centavos bigint not null check (price_centavos >= 0),
  is_available boolean not null default true,
  sort_order int not null default 0,
  unique (event_id, bundle_id)
);
create index event_bundles_event_idx on public.event_bundles (event_id);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
-- id is generated on the tablet; it is the idempotency key for sync.
create table public.transactions (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete restrict,
  staff_id uuid not null references public.staff (id),
  device_user_id uuid references auth.users (id),
  client_created_at timestamptz not null,
  synced_at timestamptz not null default now(),
  subtotal_centavos bigint not null check (subtotal_centavos >= 0),
  discount_type public.discount_type,
  -- fixed: centavos. percent: basis points (1050 = 10.50%).
  discount_value bigint,
  discount_centavos bigint not null default 0 check (discount_centavos >= 0),
  discount_reason text,
  total_centavos bigint not null check (total_centavos >= 0),
  payment_method public.payment_method not null,
  qr_reference text,
  cash_received_centavos bigint,
  change_given_centavos bigint,
  item_count int not null default 0,
  has_bundle boolean not null default false,
  status public.txn_status not null default 'completed',
  void_reason text,
  voided_by_staff_id uuid references public.staff (id),
  voided_by_user_id uuid references auth.users (id),
  voided_at timestamptz,
  -- e.g. 'late_sync' (arrived after event closed), 'oversold', 'duplicate_qr_ref'
  flags text[] not null default '{}',
  constraint transactions_discount_chk check (
    (discount_centavos = 0) or (discount_reason is not null and length(trim(discount_reason)) > 0)
  ),
  constraint transactions_total_chk check (total_centavos = subtotal_centavos - discount_centavos),
  constraint transactions_qr_chk check (
    payment_method <> 'qr_ph' or (qr_reference is not null and length(trim(qr_reference)) > 0)
  ),
  constraint transactions_cash_chk check (
    payment_method <> 'cash' or (
      cash_received_centavos is not null and change_given_centavos is not null
      and cash_received_centavos >= total_centavos
      and change_given_centavos = cash_received_centavos - total_centavos
    )
  ),
  constraint transactions_void_chk check (
    status = 'completed' or (void_reason is not null and voided_at is not null)
  )
);
create index transactions_business_time_idx on public.transactions (business_id, client_created_at desc);
create index transactions_event_idx on public.transactions (event_id, client_created_at);
create index transactions_qr_idx on public.transactions (business_id, qr_reference) where qr_reference is not null;
create index transactions_staff_idx on public.transactions (staff_id);

create table public.transaction_lines (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  position int not null default 0,
  kind public.line_kind not null,
  product_id uuid references public.products (id),
  event_product_id uuid references public.event_products (id),
  bundle_id uuid references public.bundles (id),
  event_bundle_id uuid references public.event_bundles (id),
  name_snapshot text not null,
  quantity int not null check (quantity > 0),
  unit_price_centavos bigint not null check (unit_price_centavos >= 0),
  line_total_centavos bigint not null check (line_total_centavos >= 0),
  constraint transaction_lines_kind_chk check (
    (kind = 'product' and product_id is not null and event_product_id is not null and bundle_id is null)
    or (kind = 'bundle' and bundle_id is not null and event_bundle_id is not null and product_id is null)
  ),
  constraint transaction_lines_total_chk check (line_total_centavos = unit_price_centavos * quantity)
);
create index transaction_lines_txn_idx on public.transaction_lines (transaction_id);

-- One row per product actually handed over. Single-product lines get one row too,
-- so all product analytics read from this table.
create table public.transaction_line_components (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  line_id uuid not null references public.transaction_lines (id) on delete cascade,
  event_product_id uuid not null references public.event_products (id),
  product_id uuid not null references public.products (id),
  quantity int not null check (quantity > 0),
  -- Event price of the product at sale time (for "vs. buying separately").
  regular_unit_price_centavos bigint not null check (regular_unit_price_centavos >= 0),
  -- Share of the line total (before transaction discount). Sums exactly to line total.
  allocated_revenue_centavos bigint not null check (allocated_revenue_centavos >= 0),
  -- Share of the transaction discount. Sums exactly to transaction discount.
  allocated_discount_centavos bigint not null default 0 check (allocated_discount_centavos >= 0),
  unit_cost_centavos bigint not null check (unit_cost_centavos >= 0)
);
create index tlc_txn_idx on public.transaction_line_components (transaction_id);
create index tlc_event_product_idx on public.transaction_line_components (event_product_id);
create index tlc_line_idx on public.transaction_line_components (line_id);

-- ---------------------------------------------------------------------------
-- Stock adjustments (restocks, waste, …). id may be client-generated (idempotent).
-- ---------------------------------------------------------------------------
create table public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_id uuid not null references public.events (id) on delete cascade,
  event_product_id uuid not null references public.event_products (id) on delete cascade,
  quantity_change int not null check (quantity_change <> 0),
  reason public.adjustment_reason not null,
  note text,
  unit_cost_centavos bigint not null default 0,
  staff_id uuid references public.staff (id),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  constraint stock_adjustments_sign_chk check (
    (reason = 'restock' and quantity_change > 0)
    or (reason in ('waste', 'staff_meal', 'giveaway') and quantity_change < 0)
    or reason = 'correction'
  )
);
create index stock_adjustments_event_idx on public.stock_adjustments (event_id);
create index stock_adjustments_ep_idx on public.stock_adjustments (event_product_id);

-- ---------------------------------------------------------------------------
-- Cash drawer per event
-- ---------------------------------------------------------------------------
create table public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_id uuid not null unique references public.events (id) on delete cascade,
  opening_float_centavos bigint not null default 0 check (opening_float_centavos >= 0),
  expected_cash_centavos bigint,
  counted_cash_centavos bigint,
  variance_centavos bigint,
  notes text,
  closed_by uuid references auth.users (id),
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Tablet heartbeat, so owners can see if the device is holding unsynced sales.
-- ---------------------------------------------------------------------------
create table public.device_heartbeats (
  device_user_id uuid primary key references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  unsynced_count int not null default 0,
  oldest_unsynced_at timestamptz,
  app_version text
);
