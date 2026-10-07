-- Stock maintenance, auth helpers and the RPCs the app calls.
-- All write RPCs are SECURITY DEFINER and check membership/role explicitly.
-- Errors meant for the client use SQLSTATE P0001 with a short message.

-- ===========================================================================
-- Stock ledger: stock = starting + Σ adjustments − Σ components of completed sales
-- ===========================================================================
create or replace function public._sold_qty(p_ep uuid)
returns bigint language sql stable set search_path = public as $$
  select coalesce(sum(c.quantity), 0)
  from public.transaction_line_components c
  join public.transactions t on t.id = c.transaction_id
  where c.event_product_id = p_ep and t.status = 'completed';
$$;

create or replace function public._adjusted_qty(p_ep uuid)
returns bigint language sql stable set search_path = public as $$
  select coalesce(sum(quantity_change), 0)
  from public.stock_adjustments where event_product_id = p_ep;
$$;

create or replace function public._refresh_stock(p_ep uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_stock int;
  v_last_sale timestamptz;
begin
  select ep.starting_stock + public._adjusted_qty(ep.id) - public._sold_qty(ep.id)
    into v_stock
  from public.event_products ep where ep.id = p_ep;
  if v_stock is null then return; end if;

  if v_stock <= 0 then
    select max(t.client_created_at) into v_last_sale
    from public.transaction_line_components c
    join public.transactions t on t.id = c.transaction_id
    where c.event_product_id = p_ep and t.status = 'completed';
  end if;

  update public.event_products
     set current_stock = v_stock,
         sold_out_at = case when v_stock > 0 then null
                            else coalesce(sold_out_at, v_last_sale) end
   where id = p_ep;
end $$;

-- event_products: recompute when created or when starting stock is edited
create or replace function public._tg_event_products_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.current_stock := new.starting_stock;
    new.sold_out_at := null;
  else
    new.current_stock := new.starting_stock + public._adjusted_qty(new.id) - public._sold_qty(new.id);
    if new.current_stock > 0 then new.sold_out_at := null; end if;
  end if;
  return new;
end $$;

create trigger event_products_stock
  before insert or update of starting_stock on public.event_products
  for each row execute function public._tg_event_products_stock();

create or replace function public._tg_components_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._refresh_stock(new.event_product_id);
  return null;
end $$;

create trigger components_stock
  after insert on public.transaction_line_components
  for each row execute function public._tg_components_stock();

create or replace function public._tg_txn_status_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.status is distinct from old.status then
    for r in select distinct event_product_id from public.transaction_line_components
             where transaction_id = new.id loop
      perform public._refresh_stock(r.event_product_id);
    end loop;
  end if;
  return null;
end $$;

create trigger transactions_status_stock
  after update of status on public.transactions
  for each row execute function public._tg_txn_status_stock();

create or replace function public._tg_adjustments_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then perform public._refresh_stock(new.event_product_id); end if;
  if tg_op in ('DELETE', 'UPDATE') then perform public._refresh_stock(old.event_product_id); end if;
  return null;
end $$;

create trigger stock_adjustments_stock
  after insert or update or delete on public.stock_adjustments
  for each row execute function public._tg_adjustments_stock();

-- Keep business_id consistent with the parent event (defence in depth).
create or replace function public._tg_event_child_business()
returns trigger language plpgsql set search_path = public as $$
declare v_business uuid;
begin
  select business_id into v_business from public.events where id = new.event_id;
  if v_business is distinct from new.business_id then
    raise exception 'business mismatch' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger event_products_business before insert or update on public.event_products
  for each row execute function public._tg_event_child_business();
create trigger event_bundles_business before insert or update on public.event_bundles
  for each row execute function public._tg_event_child_business();

create or replace function public._tg_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger products_touch before update on public.products
  for each row execute function public._tg_touch_updated_at();
create trigger bundles_touch before update on public.bundles
  for each row execute function public._tg_touch_updated_at();

-- ===========================================================================
-- Helpers
-- ===========================================================================
create or replace function public._fail(p_message text)
returns void language plpgsql as $$
begin raise exception '%', p_message using errcode = 'P0001'; end $$;

create or replace function public._require_owner(p_business uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner(p_business) then
    raise exception 'owner access required' using errcode = '42501';
  end if;
end $$;

create or replace function public._require_member(p_business uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_business) then
    raise exception 'not a member of this business' using errcode = '42501';
  end if;
end $$;

create or replace function public._my_staff_id(p_business uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.staff
  where business_id = p_business and user_id = auth.uid()
  order by created_at limit 1;
$$;

-- ===========================================================================
-- Business setup and staff PINs
-- ===========================================================================
create or replace function public._hash_pin(p_pin text)
returns text language sql volatile set search_path = public, extensions as $$
  select extensions.crypt(p_pin, extensions.gen_salt('bf', 8));
$$;

-- Assert a PIN is 4 digits and not already used by another active staff member.
create or replace function public._check_pin(p_business uuid, p_pin text, p_except uuid)
returns void language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if p_pin !~ '^[0-9]{4}$' then
    perform public._fail('PIN must be exactly 4 digits');
  end if;
  if exists (
    select 1 from public.staff s
    where s.business_id = p_business and s.active and s.pin_hash is not null
      and s.id is distinct from p_except
      and extensions.crypt(p_pin, s.pin_hash) = s.pin_hash
  ) then
    perform public._fail('That PIN is already used by someone else');
  end if;
end $$;

create or replace function public.set_staff_pin(p_staff_id uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_business uuid;
begin
  select business_id into v_business from public.staff where id = p_staff_id;
  if v_business is null then perform public._fail('staff not found'); end if;
  perform public._require_owner(v_business);
  perform public._check_pin(v_business, p_pin, p_staff_id);
  update public.staff set pin_hash = public._hash_pin(p_pin) where id = p_staff_id;
end $$;

-- Internal: create a business owned by p_user. Used by create_business() and seed.sql.
create or replace function public._create_business_for(
  p_user uuid, p_name text, p_owner_name text, p_owner_pin text
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_business uuid; v_staff uuid;
begin
  if p_owner_pin !~ '^[0-9]{4}$' then perform public._fail('PIN must be exactly 4 digits'); end if;
  insert into public.businesses (name) values (p_name) returning id into v_business;
  insert into public.memberships (user_id, business_id, role) values (p_user, v_business, 'owner');
  insert into public.staff (business_id, name, role, user_id, pin_hash)
    values (v_business, p_owner_name, 'owner', p_user, public._hash_pin(p_owner_pin))
    returning id into v_staff;
  return v_business;
end $$;

create or replace function public.create_business(
  p_name text, p_owner_name text, p_owner_pin text, p_load_sample boolean default false
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_business uuid;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if exists (select 1 from public.memberships where user_id = auth.uid()) then
    perform public._fail('This account already belongs to a business');
  end if;
  v_business := public._create_business_for(auth.uid(), p_name, p_owner_name, p_owner_pin);
  if p_load_sample then perform public.load_sample_data(v_business); end if;
  return v_business;
end $$;

-- ===========================================================================
-- POS snapshot: everything the tablet caches for offline selling.
-- ===========================================================================
create or replace function public.pos_snapshot(p_event_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_business uuid;
  v_event public.events;
  v_result jsonb;
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() order by created_at limit 1;
  if v_business is null then raise exception 'not a member of any business' using errcode = '42501'; end if;

  if p_event_id is not null then
    select * into v_event from public.events where id = p_event_id and business_id = v_business;
  end if;
  if v_event.id is null then
    select * into v_event from public.events where business_id = v_business and status = 'live';
  end if;

  v_result := jsonb_build_object(
    'server_time', now(),
    'business', (select jsonb_build_object('id', b.id, 'name', b.name, 'timezone', b.timezone)
                 from public.businesses b where b.id = v_business),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'role', s.role, 'pin_hash', s.pin_hash)
                       order by s.name)
      from public.staff s where s.business_id = v_business and s.active and s.pin_hash is not null
    ), '[]'::jsonb),
    'recent_qr_refs', coalesce((
      select jsonb_agg(distinct t.qr_reference)
      from public.transactions t
      where t.business_id = v_business and t.qr_reference is not null
        and t.client_created_at > now() - interval '90 days'
    ), '[]'::jsonb),
    'event', null
  );

  if v_event.id is null then return v_result; end if;

  return v_result || jsonb_build_object(
    'event', jsonb_build_object(
      'id', v_event.id, 'name', v_event.name, 'venue', v_event.venue, 'status', v_event.status,
      'starts_on', v_event.starts_on, 'ends_on', v_event.ends_on,
      'low_stock_threshold', v_event.low_stock_threshold
    ),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_product_id', ep.id, 'product_id', p.id, 'name', p.name, 'category', p.category,
        'photo_url', p.photo_url, 'price_centavos', ep.price_centavos, 'cost_centavos', p.cost_centavos,
        'stock', ep.current_stock, 'is_available', ep.is_available, 'sort_order', ep.sort_order,
        'sold_out_at', ep.sold_out_at
      ) order by ep.sort_order, p.name)
      from public.event_products ep join public.products p on p.id = ep.product_id
      where ep.event_id = v_event.id
    ), '[]'::jsonb),
    'bundles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_bundle_id', eb.id, 'bundle_id', b.id, 'name', b.name, 'type', b.type,
        'photo_url', b.photo_url, 'price_centavos', eb.price_centavos,
        'required_count', b.required_count, 'is_available', eb.is_available, 'sort_order', eb.sort_order,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'product_id', bi.product_id, 'event_product_id', ep2.id, 'quantity', bi.quantity))
          from public.bundle_items bi
          left join public.event_products ep2 on ep2.event_id = v_event.id and ep2.product_id = bi.product_id
          where bi.bundle_id = b.id
        ), '[]'::jsonb)
      ) order by eb.sort_order, b.name)
      from public.event_bundles eb join public.bundles b on b.id = eb.bundle_id
      where eb.event_id = v_event.id
    ), '[]'::jsonb),
    -- Sales voided on the server (e.g. by an owner from their phone), so the
    -- tablet can mark its local copies.
    'voided_transaction_ids', coalesce((
      select jsonb_agg(t.id) from public.transactions t
      where t.event_id = v_event.id and t.status = 'voided'
    ), '[]'::jsonb)
  );
end $$;

-- ===========================================================================
-- record_sale: idempotent on the client-generated transaction id.
-- The tablet is the source of truth for what was sold, so oversells and sales
-- that arrive after close are recorded and flagged, not rejected.
-- ===========================================================================
create or replace function public.record_sale(p_sale jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p_sale->>'id')::uuid;
  v_event public.events;
  v_staff public.staff;
  v_line jsonb;
  v_comp jsonb;
  v_lines_total bigint := 0;
  v_comp_rev bigint;
  v_disc_total bigint := 0;
  v_item_count int := 0;
  v_has_bundle boolean := false;
  v_flags text[] := '{}';
  v_inserted int;
  v_line_id uuid;
  v_pos int := 0;
begin
  if v_id is null then perform public._fail('sale id required'); end if;

  select * into v_event from public.events where id = (p_sale->>'event_id')::uuid;
  if v_event.id is null then perform public._fail('event not found'); end if;
  perform public._require_member(v_event.business_id);

  -- Idempotency: a retry of an already-recorded sale is a no-op.
  if exists (select 1 from public.transactions where id = v_id) then
    return jsonb_build_object('status', 'duplicate', 'id', v_id);
  end if;

  select * into v_staff from public.staff where id = (p_sale->>'staff_id')::uuid;
  if v_staff.id is null or v_staff.business_id <> v_event.business_id then
    perform public._fail('staff not found for this business');
  end if;

  if jsonb_typeof(p_sale->'lines') <> 'array' or jsonb_array_length(p_sale->'lines') = 0 then
    perform public._fail('sale has no lines');
  end if;

  -- Validate money: lines sum to subtotal; components sum exactly to each line.
  for v_line in select * from jsonb_array_elements(p_sale->'lines') loop
    v_lines_total := v_lines_total + (v_line->>'line_total_centavos')::bigint;
    if v_line->>'kind' = 'bundle' then v_has_bundle := true; end if;
    v_comp_rev := 0;
    if jsonb_typeof(v_line->'components') <> 'array' or jsonb_array_length(v_line->'components') = 0 then
      perform public._fail('line has no components');
    end if;
    for v_comp in select * from jsonb_array_elements(v_line->'components') loop
      v_comp_rev := v_comp_rev + (v_comp->>'allocated_revenue_centavos')::bigint;
      v_disc_total := v_disc_total + coalesce((v_comp->>'allocated_discount_centavos')::bigint, 0);
      v_item_count := v_item_count + (v_comp->>'quantity')::int;
      if not exists (select 1 from public.event_products
                     where id = (v_comp->>'event_product_id')::uuid and event_id = v_event.id) then
        perform public._fail('component is not on this event''s menu');
      end if;
    end loop;
    if v_comp_rev <> (v_line->>'line_total_centavos')::bigint then
      perform public._fail('bundle allocation does not sum to line total');
    end if;
  end loop;

  if v_lines_total <> (p_sale->>'subtotal_centavos')::bigint then
    perform public._fail('lines do not sum to subtotal');
  end if;
  if v_disc_total <> coalesce((p_sale->>'discount_centavos')::bigint, 0) then
    perform public._fail('discount allocation does not sum to discount');
  end if;

  if v_event.status = 'closed' then v_flags := array_append(v_flags, 'late_sync'); end if;
  if v_event.status = 'draft' then v_flags := array_append(v_flags, 'event_not_live'); end if;
  if nullif(trim(p_sale->>'qr_reference'), '') is not null and exists (
    select 1 from public.transactions
    where business_id = v_event.business_id and qr_reference = trim(p_sale->>'qr_reference')
  ) then
    v_flags := array_append(v_flags, 'duplicate_qr_ref');
  end if;

  insert into public.transactions (
    id, business_id, event_id, staff_id, device_user_id, client_created_at,
    subtotal_centavos, discount_type, discount_value, discount_centavos, discount_reason, total_centavos,
    payment_method, qr_reference, cash_received_centavos, change_given_centavos,
    item_count, has_bundle, flags
  ) values (
    v_id, v_event.business_id, v_event.id, v_staff.id, auth.uid(),
    (p_sale->>'client_created_at')::timestamptz,
    (p_sale->>'subtotal_centavos')::bigint,
    nullif(p_sale->>'discount_type', '')::public.discount_type,
    (p_sale->>'discount_value')::bigint,
    coalesce((p_sale->>'discount_centavos')::bigint, 0),
    nullif(trim(p_sale->>'discount_reason'), ''),
    (p_sale->>'total_centavos')::bigint,
    (p_sale->>'payment_method')::public.payment_method,
    nullif(trim(p_sale->>'qr_reference'), ''),
    (p_sale->>'cash_received_centavos')::bigint,
    (p_sale->>'change_given_centavos')::bigint,
    v_item_count, v_has_bundle, v_flags
  ) on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('status', 'duplicate', 'id', v_id);
  end if;

  for v_line in select * from jsonb_array_elements(p_sale->'lines') loop
    v_line_id := coalesce((v_line->>'id')::uuid, gen_random_uuid());
    insert into public.transaction_lines (
      id, business_id, transaction_id, position, kind, product_id, event_product_id,
      bundle_id, event_bundle_id, name_snapshot, quantity, unit_price_centavos, line_total_centavos
    ) values (
      v_line_id, v_event.business_id, v_id, v_pos,
      (v_line->>'kind')::public.line_kind,
      (v_line->>'product_id')::uuid, (v_line->>'event_product_id')::uuid,
      (v_line->>'bundle_id')::uuid, (v_line->>'event_bundle_id')::uuid,
      v_line->>'name_snapshot', (v_line->>'quantity')::int,
      (v_line->>'unit_price_centavos')::bigint, (v_line->>'line_total_centavos')::bigint
    );
    v_pos := v_pos + 1;

    insert into public.transaction_line_components (
      business_id, transaction_id, line_id, event_product_id, product_id, quantity,
      regular_unit_price_centavos, allocated_revenue_centavos, allocated_discount_centavos, unit_cost_centavos
    )
    select v_event.business_id, v_id, v_line_id,
           (c->>'event_product_id')::uuid, (c->>'product_id')::uuid, (c->>'quantity')::int,
           (c->>'regular_unit_price_centavos')::bigint, (c->>'allocated_revenue_centavos')::bigint,
           coalesce((c->>'allocated_discount_centavos')::bigint, 0), (c->>'unit_cost_centavos')::bigint
    from jsonb_array_elements(v_line->'components') c;
  end loop;

  -- Stock triggers have run; flag oversells for the owner to review.
  if exists (
    select 1 from public.transaction_line_components c
    join public.event_products ep on ep.id = c.event_product_id
    where c.transaction_id = v_id and ep.current_stock < 0
  ) then
    v_flags := array_append(v_flags, 'oversold');
    update public.transactions set flags = v_flags where id = v_id;
  end if;

  return jsonb_build_object('status', 'ok', 'id', v_id, 'flags', to_jsonb(v_flags));
end $$;

-- ===========================================================================
-- void_sale: owners may void anything with a reason. The device may only
-- "staff undo" its own sale within ~60s (2 min tolerance for clock skew).
-- Idempotent. Never deletes; the stock trigger returns component stock.
-- ===========================================================================
create or replace function public.void_sale(
  p_transaction_id uuid, p_reason text, p_staff_id uuid default null, p_voided_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_txn public.transactions;
  v_role public.member_role;
  v_at timestamptz := coalesce(p_voided_at, now());
begin
  select * into v_txn from public.transactions where id = p_transaction_id for update;
  if v_txn.id is null then
    raise exception 'transaction not found' using errcode = 'P0002';
  end if;
  v_role := public.my_role(v_txn.business_id);
  if v_role is null then raise exception 'not a member of this business' using errcode = '42501'; end if;

  if v_txn.status = 'voided' then
    return jsonb_build_object('status', 'already_voided', 'id', v_txn.id);
  end if;
  if coalesce(trim(p_reason), '') = '' then perform public._fail('a void reason is required'); end if;

  if v_role = 'device' then
    if p_reason <> 'staff undo' then perform public._fail('only owners can void sales'); end if;
    if v_txn.device_user_id is distinct from auth.uid() then perform public._fail('can only undo this tablet''s sales'); end if;
    if v_at - v_txn.client_created_at > interval '2 minutes' then
      perform public._fail('undo window has passed');
    end if;
  end if;

  update public.transactions set
    status = 'voided',
    void_reason = trim(p_reason),
    voided_at = v_at,
    voided_by_user_id = auth.uid(),
    voided_by_staff_id = coalesce(p_staff_id, public._my_staff_id(v_txn.business_id))
  where id = v_txn.id;

  return jsonb_build_object('status', 'ok', 'id', v_txn.id);
end $$;

-- ===========================================================================
-- Stock adjustments (restock, waste, staff meal, giveaway, correction).
-- Idempotent on a client-supplied id. Sales are locked once an event closes.
-- ===========================================================================
create or replace function public.adjust_stock(p_adjustment jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := coalesce((p_adjustment->>'id')::uuid, gen_random_uuid());
  v_ep public.event_products;
  v_event public.events;
  v_cost bigint;
  v_inserted int;
begin
  select * into v_ep from public.event_products where id = (p_adjustment->>'event_product_id')::uuid;
  if v_ep.id is null then perform public._fail('menu item not found'); end if;
  perform public._require_member(v_ep.business_id);
  select * into v_event from public.events where id = v_ep.event_id;
  if v_event.status = 'closed' then perform public._fail('event is closed'); end if;
  select cost_centavos into v_cost from public.products where id = v_ep.product_id;

  insert into public.stock_adjustments (
    id, business_id, event_id, event_product_id, quantity_change, reason, note,
    unit_cost_centavos, staff_id, created_by, created_at
  ) values (
    v_id, v_ep.business_id, v_ep.event_id, v_ep.id,
    (p_adjustment->>'quantity_change')::int,
    (p_adjustment->>'reason')::public.adjustment_reason,
    nullif(trim(p_adjustment->>'note'), ''),
    v_cost,
    coalesce((p_adjustment->>'staff_id')::uuid, public._my_staff_id(v_ep.business_id)),
    auth.uid(),
    coalesce((p_adjustment->>'created_at')::timestamptz, now())
  ) on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;

  return jsonb_build_object('status', case when v_inserted = 0 then 'duplicate' else 'ok' end, 'id', v_id);
end $$;

create or replace function public.set_availability(p_event_product_id uuid, p_available boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_business uuid;
begin
  select business_id into v_business from public.event_products where id = p_event_product_id;
  if v_business is null then perform public._fail('menu item not found'); end if;
  perform public._require_member(v_business);
  update public.event_products set is_available = p_available where id = p_event_product_id;
end $$;

create or replace function public.device_heartbeat(
  p_unsynced_count int, p_oldest_unsynced_at timestamptz, p_app_version text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_business uuid;
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() and role = 'device' limit 1;
  if v_business is null then return; end if;
  insert into public.device_heartbeats (device_user_id, business_id, last_seen_at, unsynced_count, oldest_unsynced_at, app_version)
  values (auth.uid(), v_business, now(), p_unsynced_count, p_oldest_unsynced_at, p_app_version)
  on conflict (device_user_id) do update set
    last_seen_at = excluded.last_seen_at,
    unsynced_count = excluded.unsynced_count,
    oldest_unsynced_at = excluded.oldest_unsynced_at,
    app_version = excluded.app_version;
end $$;

-- ===========================================================================
-- Event lifecycle
-- ===========================================================================
create or replace function public.set_event_status(p_event_id uuid, p_status public.event_status)
returns void language plpgsql security definer set search_path = public as $$
declare v_event public.events;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if v_event.id is null then perform public._fail('event not found'); end if;
  perform public._require_owner(v_event.business_id);

  if p_status = 'closed' then perform public._fail('use close_event to close an event'); end if;
  if p_status = 'live' and exists (
    select 1 from public.events where business_id = v_event.business_id and status = 'live' and id <> v_event.id
  ) then
    perform public._fail('Another event is already live. Close it first.');
  end if;
  if p_status = 'draft' and exists (select 1 from public.transactions where event_id = v_event.id) then
    perform public._fail('This event already has sales; it cannot go back to draft');
  end if;

  update public.events set
    status = p_status,
    went_live_at = case when p_status = 'live' then coalesce(went_live_at, now()) else went_live_at end,
    closed_at = case when p_status = 'live' then null else closed_at end,
    closed_by = case when p_status = 'live' then null else closed_by end
  where id = v_event.id;
end $$;

create or replace function public.duplicate_event(
  p_source_event_id uuid, p_name text, p_venue text, p_starts_on date, p_ends_on date
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_src public.events; v_new uuid;
begin
  select * into v_src from public.events where id = p_source_event_id;
  if v_src.id is null then perform public._fail('event not found'); end if;
  perform public._require_owner(v_src.business_id);

  insert into public.events (business_id, name, venue, starts_on, ends_on, low_stock_threshold)
  values (v_src.business_id, p_name, p_venue, p_starts_on, p_ends_on, v_src.low_stock_threshold)
  returning id into v_new;

  insert into public.event_products (business_id, event_id, product_id, price_centavos, starting_stock, is_available, sort_order)
  select ep.business_id, v_new, ep.product_id, ep.price_centavos, ep.starting_stock, true, ep.sort_order
  from public.event_products ep join public.products p on p.id = ep.product_id
  where ep.event_id = v_src.id and p.active;

  insert into public.event_bundles (business_id, event_id, bundle_id, price_centavos, is_available, sort_order)
  select eb.business_id, v_new, eb.bundle_id, eb.price_centavos, true, eb.sort_order
  from public.event_bundles eb join public.bundles b on b.id = eb.bundle_id
  where eb.event_id = v_src.id and b.active;

  return v_new;
end $$;

create or replace function public.set_opening_float(p_event_id uuid, p_opening_float_centavos bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_business uuid;
begin
  select business_id into v_business from public.events where id = p_event_id;
  if v_business is null then perform public._fail('event not found'); end if;
  perform public._require_owner(v_business);
  if p_opening_float_centavos < 0 then perform public._fail('opening float cannot be negative'); end if;
  insert into public.cash_sessions (business_id, event_id, opening_float_centavos)
  values (v_business, p_event_id, p_opening_float_centavos)
  on conflict (event_id) do update set opening_float_centavos = excluded.opening_float_centavos;
end $$;

-- Expected cash = opening float + cash sales (cash received − change given).
create or replace function public.expected_cash(p_event_id uuid)
returns bigint language plpgsql stable security definer set search_path = public as $$
declare v_business uuid;
begin
  select business_id into v_business from public.events where id = p_event_id;
  if v_business is null then perform public._fail('event not found'); end if;
  perform public._require_owner(v_business);
  return coalesce((select opening_float_centavos from public.cash_sessions where event_id = p_event_id), 0)
       + coalesce((select sum(cash_received_centavos - change_given_centavos)
                   from public.transactions
                   where event_id = p_event_id and status = 'completed' and payment_method = 'cash'), 0);
end $$;

-- Close: record waste, reconcile cash, snapshot leftovers, lock sales.
-- p_waste: [{ "event_product_id": uuid, "quantity": int, "note": text }]
create or replace function public.close_event(
  p_event_id uuid, p_counted_cash_centavos bigint, p_notes text default null, p_waste jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_event public.events;
  v_w jsonb;
  v_expected bigint;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if v_event.id is null then perform public._fail('event not found'); end if;
  perform public._require_owner(v_event.business_id);
  if v_event.status = 'closed' then perform public._fail('event is already closed'); end if;
  if p_counted_cash_centavos is null or p_counted_cash_centavos < 0 then
    perform public._fail('enter the counted cash');
  end if;

  for v_w in select * from jsonb_array_elements(coalesce(p_waste, '[]'::jsonb)) loop
    if coalesce((v_w->>'quantity')::int, 0) > 0 then
      insert into public.stock_adjustments (
        business_id, event_id, event_product_id, quantity_change, reason, note,
        unit_cost_centavos, staff_id, created_by)
      select ep.business_id, ep.event_id, ep.id, -(v_w->>'quantity')::int, 'waste',
             coalesce(nullif(trim(v_w->>'note'), ''), 'end-of-day waste'),
             p.cost_centavos, public._my_staff_id(ep.business_id), auth.uid()
      from public.event_products ep join public.products p on p.id = ep.product_id
      where ep.id = (v_w->>'event_product_id')::uuid and ep.event_id = v_event.id;
    end if;
  end loop;

  v_expected := public.expected_cash(v_event.id);
  insert into public.cash_sessions (business_id, event_id, opening_float_centavos)
  values (v_event.business_id, v_event.id, 0)
  on conflict (event_id) do nothing;
  update public.cash_sessions set
    expected_cash_centavos = v_expected,
    counted_cash_centavos = p_counted_cash_centavos,
    variance_centavos = p_counted_cash_centavos - v_expected,
    notes = nullif(trim(p_notes), ''),
    closed_by = auth.uid(),
    closed_at = now()
  where event_id = v_event.id;

  update public.event_products ep set
    closing_stock = greatest(ep.current_stock, 0),
    closing_unit_cost = p.cost_centavos
  from public.products p
  where p.id = ep.product_id and ep.event_id = v_event.id;

  update public.events set status = 'closed', closed_at = now(), closed_by = auth.uid()
  where id = v_event.id;

  return jsonb_build_object(
    'expected_cash_centavos', v_expected,
    'counted_cash_centavos', p_counted_cash_centavos,
    'variance_centavos', p_counted_cash_centavos - v_expected
  );
end $$;

-- ===========================================================================
-- Sample data (used by the setup screen checkbox and seed.sql)
-- ===========================================================================
create or replace function public.load_sample_data(p_business uuid)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_butter uuid; v_ube uuid; v_choc uuid; v_almond uuid; v_ensay uuid; v_tart uuid; v_cookie uuid;
  v_ube_box uuid; v_duo uuid; v_any6 uuid; v_pick3 uuid;
  v_event uuid;
  v_today date := (now() at time zone 'Asia/Manila')::date;
begin
  if auth.uid() is not null then perform public._require_owner(p_business); end if;

  insert into public.products (business_id, name, category, default_price_centavos, cost_centavos) values
    (p_business, 'Butter Croissant', 'Croissants', 9500, 3800) returning id into v_butter;
  insert into public.products (business_id, name, category, default_price_centavos, cost_centavos) values
    (p_business, 'Ube Croissant', 'Croissants', 12000, 5000) returning id into v_ube;
  insert into public.products (business_id, name, category, default_price_centavos, cost_centavos) values
    (p_business, 'Pain au Chocolat', 'Croissants', 11000, 4500) returning id into v_choc;
  insert into public.products (business_id, name, category, default_price_centavos, cost_centavos) values
    (p_business, 'Almond Croissant', 'Croissants', 13000, 5500) returning id into v_almond;
  insert into public.products (business_id, name, category, default_price_centavos, cost_centavos) values
    (p_business, 'Ensaymada', 'Pastries', 8500, 3000) returning id into v_ensay;
  insert into public.products (business_id, name, category, default_price_centavos, cost_centavos) values
    (p_business, 'Calamansi Tart', 'Pastries', 9000, 3500) returning id into v_tart;
  insert into public.products (business_id, name, category, default_price_centavos, cost_centavos) values
    (p_business, 'Brown Butter Cookie', 'Cookies', 6500, 2200) returning id into v_cookie;

  -- Fixed bundles
  insert into public.bundles (business_id, name, type, price_centavos) values
    (p_business, 'Ube Box (6)', 'fixed', 65000) returning id into v_ube_box;
  insert into public.bundle_items (business_id, bundle_id, product_id, quantity) values
    (p_business, v_ube_box, v_ube, 6);
  insert into public.bundles (business_id, name, type, price_centavos) values
    (p_business, 'Breakfast Duo', 'fixed', 19000) returning id into v_duo;
  insert into public.bundle_items (business_id, bundle_id, product_id, quantity) values
    (p_business, v_duo, v_butter, 1), (p_business, v_duo, v_choc, 1);

  -- Mix-and-match bundles
  insert into public.bundles (business_id, name, type, price_centavos, required_count) values
    (p_business, 'Any 6 Croissants', 'mix_match', 60000, 6) returning id into v_any6;
  insert into public.bundle_items (business_id, bundle_id, product_id) values
    (p_business, v_any6, v_butter), (p_business, v_any6, v_ube),
    (p_business, v_any6, v_choc), (p_business, v_any6, v_almond);
  insert into public.bundles (business_id, name, type, price_centavos, required_count) values
    (p_business, 'Pick 3 Treats', 'mix_match', 21000, 3) returning id into v_pick3;
  insert into public.bundle_items (business_id, bundle_id, product_id) values
    (p_business, v_pick3, v_ensay), (p_business, v_pick3, v_tart), (p_business, v_pick3, v_cookie);

  -- Sample staff (PINs 1111 and 2222)
  insert into public.staff (business_id, name, role, pin_hash) values
    (p_business, 'Staff One', 'staff', public._hash_pin('1111')),
    (p_business, 'Staff Two', 'staff', public._hash_pin('2222'));

  -- A draft event for today with the whole menu
  insert into public.events (business_id, name, venue, starts_on, ends_on)
  values (p_business, 'Sample Weekend Market', 'Salcedo Saturday Market', v_today, v_today)
  returning id into v_event;

  insert into public.event_products (business_id, event_id, product_id, price_centavos, starting_stock, sort_order)
  select p_business, v_event, p.id, p.default_price_centavos,
         case when p.id = v_almond then 12 else 24 end,
         row_number() over (order by p.category, p.name)
  from public.products p where p.business_id = p_business;

  insert into public.event_bundles (business_id, event_id, bundle_id, price_centavos, sort_order)
  select p_business, v_event, b.id, b.price_centavos, row_number() over (order by b.name)
  from public.bundles b where b.business_id = p_business;

  return v_event;
end $$;

-- ===========================================================================
-- Function privileges: internal helpers are not callable from the API.
-- ===========================================================================
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.is_member(uuid), public.is_owner(uuid), public.my_role(uuid),
  public.create_business(text, text, text, boolean),
  public.set_staff_pin(uuid, text),
  public.pos_snapshot(uuid),
  public.record_sale(jsonb),
  public.void_sale(uuid, text, uuid, timestamptz),
  public.adjust_stock(jsonb),
  public.set_availability(uuid, boolean),
  public.device_heartbeat(int, timestamptz, text),
  public.set_event_status(uuid, public.event_status),
  public.duplicate_event(uuid, text, text, date, date),
  public.set_opening_float(uuid, bigint),
  public.expected_cash(uuid),
  public.close_event(uuid, bigint, text, jsonb),
  public.load_sample_data(uuid)
to authenticated;
