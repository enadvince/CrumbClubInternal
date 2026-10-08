-- Collision-proof order numbering.
--  * pos_devices: every POS tablet gets a short code (T1, T2...) per business.
--  * transactions gain client_order_id (= the client-generated id, the idempotency key),
--    order_number ({DEVICE_CODE}-{YYMMDD}-{SEQ}), device_id, created_at_device and a
--    server created_at. The server clock is authoritative; the device time is kept
--    separately, with the measured clock offset, to spot tablet clock drift.
--  * record_sale only accepts a device_id that belongs to the calling device login.
-- Backward compatible: payloads without an order number (older app versions) still sync.

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------
create table public.pos_devices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  device_user_id uuid unique references auth.users (id) on delete set null,
  device_code text not null check (device_code ~ '^T[0-9]{1,3}$'),
  label text,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (business_id, device_code)
);
create index pos_devices_business_idx on public.pos_devices (business_id);

alter table public.pos_devices enable row level security;
create policy pos_devices_select on public.pos_devices
  for select to authenticated using (public.is_owner(business_id) or device_user_id = auth.uid());
revoke all on public.pos_devices from anon, authenticated;
grant select on public.pos_devices to authenticated;

-- Tablets paired before this migration get codes in pairing order.
insert into public.pos_devices (business_id, device_user_id, device_code, label, registered_at)
select m.business_id, m.user_id,
       'T' || row_number() over (partition by m.business_id order by m.created_at, m.user_id),
       m.label, m.created_at
from public.memberships m
where m.role = 'device';

-- Next free code for a business. Serialised per business with an advisory lock.
create or replace function public._next_device_code(p_business uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare v_next int;
begin
  perform pg_advisory_xact_lock(hashtext('pos_devices:' || p_business::text));
  select coalesce(max(substring(device_code from 2)::int), 0) + 1 into v_next
  from public.pos_devices where business_id = p_business;
  return 'T' || v_next;
end $$;

-- Called by a paired tablet (its device login) to claim its code. Idempotent:
-- a tablet that already has a code gets the same one back.
create or replace function public.claim_device_code(p_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_business uuid;
  v_label text;
  v_device public.pos_devices;
begin
  select business_id, label into v_business, v_label from public.memberships
   where user_id = auth.uid() and role = 'device' limit 1;
  if v_business is null then raise exception 'only a paired POS tablet can claim a device code' using errcode = '42501'; end if;

  select * into v_device from public.pos_devices where device_user_id = auth.uid();
  if v_device.id is null then
    insert into public.pos_devices (business_id, device_user_id, device_code, label)
    values (v_business, auth.uid(), public._next_device_code(v_business), coalesce(nullif(trim(p_label), ''), v_label))
    returning * into v_device;
  end if;
  update public.pos_devices set last_seen_at = now() where id = v_device.id;
  return jsonb_build_object('device_id', v_device.id, 'device_code', v_device.device_code, 'label', v_device.label);
end $$;

-- ---------------------------------------------------------------------------
-- Transactions: order numbers, device, server vs device time
-- ---------------------------------------------------------------------------
alter table public.transactions
  add column client_order_id uuid generated always as (id) stored,
  add column order_number text,
  add column device_id uuid references public.pos_devices (id) on delete set null,
  add column created_at_device timestamptz generated always as (client_created_at) stored,
  add column created_at timestamptz not null default now(),
  -- server clock minus device clock when the tablet sent the order (ms); null if unknown
  add column clock_offset_ms bigint;

-- Rows from before this migration: server time is when they synced; number them LEGACY-YYMMDD-NNNN.
update public.transactions t set
  created_at = t.synced_at,
  order_number = 'LEGACY-' || to_char(t.client_created_at at time zone 'Asia/Manila', 'YYMMDD') || '-' ||
                 lpad(n.seq::text, 4, '0')
from (
  select id, row_number() over (
    partition by business_id, (client_created_at at time zone 'Asia/Manila')::date
    order by client_created_at, id) as seq
  from public.transactions
) n
where n.id = t.id;

alter table public.transactions
  alter column order_number set not null,
  add constraint transactions_client_order_id_key unique (client_order_id),
  add constraint transactions_order_number_key unique (business_id, order_number);
create index transactions_device_idx on public.transactions (device_id, created_at desc);

-- ---------------------------------------------------------------------------
-- record_sale v3: order number, device ownership, clock offset.
-- ---------------------------------------------------------------------------
create or replace function public.record_sale(p_sale jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p_sale->>'id')::uuid;
  v_event public.events;
  v_staff public.staff;
  v_role public.member_role;
  v_device public.pos_devices;
  v_order_number text := nullif(trim(p_sale->>'order_number'), '');
  v_sent_at timestamptz := (p_sale->>'device_sent_at')::timestamptz;
  v_offset_ms bigint;
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
    return jsonb_build_object('status', 'duplicate', 'id', v_id,
      'order_number', (select order_number from public.transactions where id = v_id));
  end if;

  -- A device may only record orders as itself.
  v_role := public.my_role(v_event.business_id);
  select * into v_device from public.pos_devices where device_user_id = auth.uid();
  if nullif(p_sale->>'device_id', '') is not null then
    if v_role = 'device' and (v_device.id is null or v_device.id <> (p_sale->>'device_id')::uuid) then
      raise exception 'device_id does not belong to this tablet' using errcode = '42501';
    end if;
    if v_role = 'owner' then
      select * into v_device from public.pos_devices
       where id = (p_sale->>'device_id')::uuid and business_id = v_event.business_id;
    end if;
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

  -- Order number: must carry this tablet's code. Older app versions send none.
  if v_order_number is not null then
    if v_order_number !~ '^T[0-9]{1,3}-[0-9]{6}-[0-9]{4,}$' then
      perform public._fail('order number has the wrong format');
    end if;
    if v_device.id is not null and split_part(v_order_number, '-', 1) <> v_device.device_code then
      perform public._fail('order number does not match this tablet''s code');
    end if;
  else
    v_order_number := coalesce(v_device.device_code, 'X') || '-' ||
      to_char((p_sale->>'client_created_at')::timestamptz at time zone 'Asia/Manila', 'YYMMDD') || '-' ||
      upper(substr(md5(v_id::text), 1, 6));
  end if;
  -- Never reject a real sale over its number: keep it, make the number unique, flag it.
  if exists (select 1 from public.transactions where business_id = v_event.business_id and order_number = v_order_number) then
    v_order_number := v_order_number || '-' || upper(substr(md5(v_id::text), 1, 4));
    v_flags := array_append(v_flags, 'order_number_conflict');
  end if;

  if v_sent_at is not null then
    v_offset_ms := (extract(epoch from (now() - v_sent_at)) * 1000)::bigint;
    if abs(v_offset_ms) > 5 * 60 * 1000 then v_flags := array_append(v_flags, 'clock_drift'); end if;
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
    item_count, has_bundle, flags, order_number, device_id, clock_offset_ms
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
    v_item_count, v_has_bundle, v_flags, v_order_number, v_device.id, v_offset_ms
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

  if v_device.id is not null then
    update public.pos_devices set last_seen_at = now() where id = v_device.id;
  end if;

  return jsonb_build_object('status', 'ok', 'id', v_id, 'order_number', v_order_number, 'flags', to_jsonb(v_flags));
end $$;

-- ---------------------------------------------------------------------------
-- Lightweight health check for the tablet: proves the API and auth work, and
-- returns the server clock so the tablet can measure its own drift.
-- ---------------------------------------------------------------------------
create or replace function public.pos_ping()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('server_time', now(), 'member', exists (select 1 from public.memberships where user_id = auth.uid()));
$$;

-- Heartbeat also marks the device as seen.
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
  update public.pos_devices set last_seen_at = now() where device_user_id = auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- pos_snapshot: also sends this tablet's device code and the highest order
-- sequence the server has seen per day, so a reinstalled tablet never reuses
-- a number.
-- ---------------------------------------------------------------------------
create or replace function public._pos_device_state(p_business uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when d.id is null then null else jsonb_build_object(
    'id', d.id, 'code', d.device_code, 'label', d.label,
    'order_counters', coalesce((
      select jsonb_object_agg(day, max_seq) from (
        select split_part(t.order_number, '-', 2) as day, max(split_part(t.order_number, '-', 3)::int) as max_seq
        from public.transactions t
        where t.device_id = d.id and t.order_number ~ '^T[0-9]{1,3}-[0-9]{6}-[0-9]{4,}$'
          and t.client_created_at > now() - interval '3 days'
        group by 1
      ) c
    ), '{}'::jsonb)
  ) end
  from (select 1) one
  left join public.pos_devices d on d.device_user_id = auth.uid() and d.business_id = p_business;
$$;

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
    'device', public._pos_device_state(v_business),
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
    'discount_options', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'type', d.type, 'value', d.value)
                       order by d.sort_order, d.name)
      from public.discount_options d where d.business_id = v_business and d.active
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
    'voided_transaction_ids', coalesce((
      select jsonb_agg(t.id) from public.transactions t
      where t.event_id = v_event.id and t.status = 'voided'
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public._next_device_code(uuid) from public, anon, authenticated;
revoke all on function public._pos_device_state(uuid) from public, anon, authenticated;
revoke all on function public.claim_device_code(text) from public, anon;
revoke all on function public.pos_ping() from public, anon;
grant execute on function public.claim_device_code(text), public.pos_ping() to authenticated;
