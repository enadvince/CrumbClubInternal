-- Owner pages save an edit only if the row hasn't changed since it was opened (compare-and-set
-- on updated_at), so two owners editing the same thing get a warning instead of a silent
-- overwrite. products and bundles already have updated_at; add it where owners edit too.
--
-- The touch triggers on events, event_products and event_bundles only fire for the columns
-- owners (or the tablet's sold-out toggle) edit. Stock is recalculated on every sale; that
-- must not count as "someone else changed it".

alter table public.discount_options add column if not exists updated_at timestamptz not null default now();
alter table public.events add column if not exists updated_at timestamptz not null default now();
alter table public.event_products add column if not exists updated_at timestamptz not null default now();
alter table public.event_bundles add column if not exists updated_at timestamptz not null default now();

drop trigger if exists discount_options_touch on public.discount_options;
create trigger discount_options_touch before update on public.discount_options
  for each row execute function public._tg_touch_updated_at();

drop trigger if exists events_touch on public.events;
create trigger events_touch before update of name, venue, starts_on, ends_on, low_stock_threshold on public.events
  for each row execute function public._tg_touch_updated_at();

drop trigger if exists event_products_touch on public.event_products;
create trigger event_products_touch before update of price_centavos, starting_stock, is_available, sort_order on public.event_products
  for each row execute function public._tg_touch_updated_at();

drop trigger if exists event_bundles_touch on public.event_bundles;
create trigger event_bundles_touch before update of price_centavos, is_available, sort_order on public.event_bundles
  for each row execute function public._tg_touch_updated_at();
