-- Low stock. Stock stays per event (event_products.current_stock, a ledger kept by triggers).
-- Products gain:
--   track_stock          false for things made to order (no stock count, never "out")
--   low_stock_threshold  per-product override; null uses the event's threshold (default 5)
-- Sales are never blocked by stock; oversells are recorded and flagged for tracked products only.

alter table public.products
  add column track_stock boolean not null default true,
  add column low_stock_threshold int check (low_stock_threshold is null or low_stock_threshold >= 0);

-- The tablet needs both per product: wrap the snapshot rather than restating it.
alter function public.pos_snapshot(uuid) rename to _pos_snapshot_v3;
create or replace function public.pos_snapshot(p_event_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_base jsonb := public._pos_snapshot_v3(p_event_id);
begin
  if jsonb_typeof(v_base->'products') <> 'array' then return v_base; end if;
  return v_base || jsonb_build_object('products', coalesce((
    select jsonb_agg(e.p || jsonb_build_object('track_stock', pr.track_stock, 'low_stock_threshold', pr.low_stock_threshold) order by e.n)
    from jsonb_array_elements(v_base->'products') with ordinality as e(p, n)
    join public.products pr on pr.id = (e.p->>'product_id')::uuid
  ), '[]'::jsonb));
end $$;

-- "oversold" only makes sense for products whose stock is counted.
create or replace function public._tg_transactions_oversold()
returns trigger language plpgsql set search_path = public as $$
begin
  if 'oversold' = any(new.flags) and not ('oversold' = any(coalesce(old.flags, '{}'))) and not exists (
    select 1 from public.transaction_line_components c
    join public.event_products ep on ep.id = c.event_product_id
    join public.products p on p.id = c.product_id
    where c.transaction_id = new.id and ep.current_stock < 0 and p.track_stock
  ) then
    new.flags := array_remove(new.flags, 'oversold');
  end if;
  return new;
end $$;

create trigger transactions_oversold
  before update of flags on public.transactions
  for each row execute function public._tg_transactions_oversold();

-- Owners: tracked products at or below their threshold for an event (default: the live one).
create or replace function public.low_stock_report(p_event_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_business uuid;
  v_event public.events;
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() and role = 'owner' order by created_at limit 1;
  if v_business is null then raise exception 'owner access required' using errcode = '42501'; end if;
  if p_event_id is not null then
    select * into v_event from public.events where id = p_event_id and business_id = v_business;
  else
    select * into v_event from public.events where business_id = v_business and status = 'live';
  end if;
  if v_event.id is null then return jsonb_build_object('event', null, 'items', '[]'::jsonb); end if;

  return jsonb_build_object(
    'event', jsonb_build_object('id', v_event.id, 'name', v_event.name, 'status', v_event.status),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_product_id', ep.id, 'product_id', p.id, 'name', p.name, 'category', p.category,
        'stock', ep.current_stock, 'threshold', coalesce(p.low_stock_threshold, v_event.low_stock_threshold),
        'out', ep.current_stock <= 0, 'sold_out_at', ep.sold_out_at
      ) order by ep.current_stock, p.name)
      from public.event_products ep join public.products p on p.id = ep.product_id
      where ep.event_id = v_event.id and p.track_stock
        and ep.current_stock <= coalesce(p.low_stock_threshold, v_event.low_stock_threshold)
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public._pos_snapshot_v3(uuid), public._tg_transactions_oversold() from public, anon, authenticated;
revoke all on function public.pos_snapshot(uuid), public.low_stock_report(uuid) from public, anon;
grant execute on function public.pos_snapshot(uuid), public.low_stock_report(uuid) to authenticated;
