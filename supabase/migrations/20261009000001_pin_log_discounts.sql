-- 1. PIN log: every time a PIN is used (staff or owner), read-only for owners.
-- 2. Discount options: owner-defined preset discounts, sent to the tablet.
-- 3. Voids approved with an owner PIN.

-- ---------------------------------------------------------------------------
-- PIN log. Rows are only ever added (through log_pin_use() or the server);
-- nobody can edit or delete them from the app.
-- ---------------------------------------------------------------------------
create table public.pin_uses (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  staff_id uuid references public.staff (id) on delete set null,
  -- Name and role at the time the PIN was used
  staff_name text not null,
  staff_role public.staff_role not null,
  action text not null check (action in ('sign_in', 'owner_menu', 'owner_view', 'void_approval')),
  used_at timestamptz not null,
  device_user_id uuid references auth.users (id) on delete set null,
  device_label text,
  created_at timestamptz not null default now()
);
create index pin_uses_business_used_idx on public.pin_uses (business_id, used_at desc);

alter table public.pin_uses enable row level security;
create policy pin_uses_owner_select on public.pin_uses
  for select to authenticated using (public.is_owner(business_id));
revoke all on public.pin_uses from anon, authenticated;
grant select on public.pin_uses to authenticated;

-- Internal: append a PIN use. Idempotent on the client-generated id.
create or replace function public._log_pin_use(
  p_id uuid, p_business uuid, p_staff_id uuid, p_action text, p_used_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
declare v_staff public.staff;
begin
  select * into v_staff from public.staff where id = p_staff_id and business_id = p_business;
  if v_staff.id is null then perform public._fail('staff not found'); end if;
  insert into public.pin_uses (id, business_id, staff_id, staff_name, staff_role, action, used_at, device_user_id, device_label)
  values (
    p_id, p_business, v_staff.id, v_staff.name, v_staff.role, p_action, coalesce(p_used_at, now()), auth.uid(),
    (select label from public.memberships where user_id = auth.uid() and business_id = p_business and role = 'device')
  )
  on conflict (id) do nothing;
end $$;

-- Called by the tablet (queued offline, synced later).
create or replace function public.log_pin_use(p_use jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_business uuid;
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() order by created_at limit 1;
  if v_business is null then raise exception 'not a member of any business' using errcode = '42501'; end if;
  perform public._log_pin_use((p_use->>'id')::uuid, v_business, (p_use->>'staff_id')::uuid,
                              p_use->>'action', (p_use->>'used_at')::timestamptz);
  return jsonb_build_object('status', 'ok');
end $$;

-- ---------------------------------------------------------------------------
-- Discount options
-- ---------------------------------------------------------------------------
create table public.discount_options (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  type text not null check (type in ('percent', 'fixed')),
  -- percent: basis points (1000 = 10%); fixed: centavos
  value bigint not null check (value > 0),
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  check (type <> 'percent' or value <= 10000)
);
create index discount_options_business_idx on public.discount_options (business_id);

alter table public.discount_options enable row level security;
create policy discount_options_member_select on public.discount_options
  for select to authenticated using (public.is_member(business_id));
create policy discount_options_owner_insert on public.discount_options
  for insert to authenticated with check (public.is_owner(business_id));
create policy discount_options_owner_update on public.discount_options
  for update to authenticated using (public.is_owner(business_id)) with check (public.is_owner(business_id));
create policy discount_options_owner_delete on public.discount_options
  for delete to authenticated using (public.is_owner(business_id));
revoke all on public.discount_options from anon, authenticated;
grant select, insert, update, delete on public.discount_options to authenticated;

-- ---------------------------------------------------------------------------
-- pos_snapshot: now also sends the discount options.
-- ---------------------------------------------------------------------------
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
    -- Preset discounts the owner set up (name + % or ₱ amount).
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
    -- Sales voided on the server (e.g. by an owner from their phone), so the
    -- tablet can mark its local copies.
    'voided_transaction_ids', coalesce((
      select jsonb_agg(t.id) from public.transactions t
      where t.event_id = v_event.id and t.status = 'voided'
    ), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Owner void approved with an owner PIN (owner pages). The PIN must belong to
-- an active owner of the sale's business; the void and the PIN use are recorded.
-- ---------------------------------------------------------------------------
create or replace function public.void_sale_with_owner_pin(p_transaction_id uuid, p_reason text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_business uuid;
  v_staff uuid;
  v_result jsonb;
begin
  select business_id into v_business from public.transactions where id = p_transaction_id;
  if v_business is null then raise exception 'transaction not found' using errcode = 'P0002'; end if;
  perform public._require_owner(v_business);
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then perform public._fail('Enter a 4-digit owner PIN'); end if;
  select s.id into v_staff from public.staff s
   where s.business_id = v_business and s.active and s.role = 'owner' and s.pin_hash is not null
     and extensions.crypt(p_pin, s.pin_hash) = s.pin_hash
   limit 1;
  if v_staff is null then perform public._fail('That isn''t an owner PIN'); end if;

  v_result := public.void_sale(p_transaction_id, p_reason, v_staff, now());
  if v_result->>'status' = 'ok' then
    perform public._log_pin_use(gen_random_uuid(), v_business, v_staff, 'void_approval', now());
  end if;
  return v_result;
end $$;

revoke all on function public._log_pin_use(uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.log_pin_use(jsonb) from public, anon;
revoke all on function public.void_sale_with_owner_pin(uuid, text, text) from public, anon;
grant execute on function public.log_pin_use(jsonb), public.void_sale_with_owner_pin(uuid, text, text) to authenticated;
