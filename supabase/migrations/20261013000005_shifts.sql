-- Shifts and the cash drawer, per tablet. All of it works offline: the tablet queues
-- shift open, drawer movements and shift close with client ids, and these RPCs apply them
-- idempotently. One open shift per tablet. Every order, refund and drawer movement is tied
-- to a shift.
--   expected cash = opening float + cash sales − cash refunds + cash in − cash out
-- A variance beyond the business's threshold (default ₱50) needs an owner's approval and a note.
-- The end-of-event close stays an owner task on the owner pages.

alter table public.businesses
  add column variance_threshold_centavos bigint not null default 5000 check (variance_threshold_centavos >= 0);
grant update (variance_threshold_centavos) on public.businesses to authenticated;

create table public.shifts (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  event_id uuid not null references public.events (id),
  device_id uuid references public.pos_devices (id) on delete set null,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null,
  opened_by_staff_id uuid references public.staff (id),
  opening_float_centavos bigint not null check (opening_float_centavos >= 0),
  opening_denoms jsonb,
  closed_at timestamptz,
  closed_by_staff_id uuid references public.staff (id),
  counted_cash_centavos bigint check (counted_cash_centavos >= 0),
  counted_denoms jsonb,
  -- What the tablet showed at close, and what the server computes from synced data.
  expected_cash_device_centavos bigint,
  expected_cash_centavos bigint,
  variance_centavos bigint,
  variance_note text,
  variance_approved_by_staff_id uuid references public.staff (id),
  close_note text,
  created_at timestamptz not null default now(),
  closed_synced_at timestamptz
);
create unique index shifts_one_open_per_device on public.shifts (device_id) where status = 'open';
create index shifts_business_time_idx on public.shifts (business_id, opened_at desc);
create index shifts_event_idx on public.shifts (event_id);

create table public.drawer_movements (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  shift_id uuid not null references public.shifts (id),
  kind text not null check (kind in ('cash_in', 'cash_out')),
  amount_centavos bigint not null check (amount_centavos > 0),
  reason text not null check (length(trim(reason)) > 0),
  staff_id uuid references public.staff (id),
  approved_by_staff_id uuid references public.staff (id),
  created_at_device timestamptz not null,
  created_at timestamptz not null default now(),
  check (kind = 'cash_in' or approved_by_staff_id is not null)
);
create index drawer_movements_shift_idx on public.drawer_movements (shift_id);

alter table public.transactions add column shift_id uuid references public.shifts (id);
create index transactions_shift_idx on public.transactions (shift_id);
alter table public.refunds add constraint refunds_shift_id_fkey foreign key (shift_id) references public.shifts (id);
create index refunds_shift_idx on public.refunds (shift_id);

alter table public.shifts enable row level security;
alter table public.drawer_movements enable row level security;
create policy shifts_select on public.shifts for select to authenticated using (
  public.is_owner(business_id) or device_id in (select id from public.pos_devices where device_user_id = auth.uid()));
create policy drawer_movements_select on public.drawer_movements for select to authenticated using (
  exists (select 1 from public.shifts s where s.id = shift_id));
revoke all on public.shifts, public.drawer_movements from anon, authenticated;
grant select on public.shifts, public.drawer_movements to authenticated;

-- The device (and business) a write comes from. Tablets must be registered.
create or replace function public._caller_device(p_business uuid)
returns public.pos_devices language sql stable security definer set search_path = public as $$
  select * from public.pos_devices where device_user_id = auth.uid() and business_id = p_business;
$$;

-- p: { id, event_id, opened_at, opened_by_staff_id, opening_float_centavos, opening_denoms }
create or replace function public.open_shift(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_event public.events;
  v_device public.pos_devices;
begin
  if (p->>'id') is null then perform public._fail('shift id required'); end if;
  if exists (select 1 from public.shifts where id = (p->>'id')::uuid) then
    return jsonb_build_object('status', 'duplicate', 'id', p->>'id');
  end if;
  select * into v_event from public.events where id = (p->>'event_id')::uuid;
  if v_event.id is null then perform public._fail('event not found'); end if;
  perform public._require_member(v_event.business_id);
  v_device := public._caller_device(v_event.business_id);
  if v_device.id is null then perform public._fail('only a registered POS tablet can open a shift'); end if;

  -- A shift this tablet left open (e.g. it was reset before the close synced) is closed off
  -- so the new one can open; it is marked for the owner to review.
  update public.shifts set status = 'closed', closed_at = (p->>'opened_at')::timestamptz,
         close_note = 'Closed automatically when the tablet opened a new shift'
   where device_id = v_device.id and status = 'open';

  insert into public.shifts (id, business_id, event_id, device_id, opened_at, opened_by_staff_id, opening_float_centavos, opening_denoms)
  values ((p->>'id')::uuid, v_event.business_id, v_event.id, v_device.id, (p->>'opened_at')::timestamptz,
          (select id from public.staff where id = (p->>'opened_by_staff_id')::uuid and business_id = v_event.business_id),
          (p->>'opening_float_centavos')::bigint, p->'opening_denoms');
  return jsonb_build_object('status', 'ok', 'id', p->>'id');
end $$;

-- p: { id, shift_id, kind, amount_centavos, reason, staff_id, approved_by_staff_id, created_at }
create or replace function public.record_drawer_movement(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_shift public.shifts;
begin
  if exists (select 1 from public.drawer_movements where id = (p->>'id')::uuid) then
    return jsonb_build_object('status', 'duplicate', 'id', p->>'id');
  end if;
  select * into v_shift from public.shifts where id = (p->>'shift_id')::uuid;
  if v_shift.id is null then perform public._fail('shift not found; it must sync first'); end if;
  perform public._require_member(v_shift.business_id);
  if p->>'kind' = 'cash_out' then
    perform public._require_owner_staff(v_shift.business_id, (p->>'approved_by_staff_id')::uuid);
  end if;
  insert into public.drawer_movements (id, business_id, shift_id, kind, amount_centavos, reason, staff_id, approved_by_staff_id, created_at_device)
  values ((p->>'id')::uuid, v_shift.business_id, v_shift.id, p->>'kind', (p->>'amount_centavos')::bigint, p->>'reason',
          (select id from public.staff where id = (p->>'staff_id')::uuid and business_id = v_shift.business_id),
          (select id from public.staff where id = (p->>'approved_by_staff_id')::uuid and business_id = v_shift.business_id),
          coalesce((p->>'created_at')::timestamptz, now()));
  return jsonb_build_object('status', 'ok', 'id', p->>'id');
end $$;

-- Expected cash from what the server has for a shift.
create or replace function public._shift_expected_cash(p_shift uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select s.opening_float_centavos
       + coalesce((select sum(total_centavos) from public.transactions
                   where shift_id = s.id and status = 'completed' and payment_method = 'cash'), 0)
       - coalesce((select sum(amount_centavos) from public.refunds where shift_id = s.id and method = 'cash'), 0)
       + coalesce((select sum(amount_centavos) from public.drawer_movements where shift_id = s.id and kind = 'cash_in'), 0)
       - coalesce((select sum(amount_centavos) from public.drawer_movements where shift_id = s.id and kind = 'cash_out'), 0)
  from public.shifts s where s.id = p_shift;
$$;

-- p: { id, closed_at, closed_by_staff_id, counted_cash_centavos, counted_denoms,
--      expected_cash_centavos (as shown on the tablet), variance_note, approved_by_staff_id }
create or replace function public.close_shift(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_shift public.shifts;
  v_threshold bigint;
  v_device_expected bigint := (p->>'expected_cash_centavos')::bigint;
  v_counted bigint := (p->>'counted_cash_centavos')::bigint;
  v_expected bigint;
begin
  select * into v_shift from public.shifts where id = (p->>'id')::uuid for update;
  if v_shift.id is null then perform public._fail('shift not found; it must sync first'); end if;
  perform public._require_member(v_shift.business_id);
  if v_shift.status = 'closed' and v_shift.counted_cash_centavos is not null then
    return jsonb_build_object('status', 'duplicate', 'id', v_shift.id);
  end if;
  if v_counted is null or v_counted < 0 then perform public._fail('enter the counted cash'); end if;
  select variance_threshold_centavos into v_threshold from public.businesses where id = v_shift.business_id;
  -- The approval rule is checked against what the cashier saw on the tablet.
  if abs(v_counted - coalesce(v_device_expected, v_counted)) > v_threshold then
    perform public._require_owner_staff(v_shift.business_id, (p->>'approved_by_staff_id')::uuid);
    if coalesce(trim(p->>'variance_note'), '') = '' then perform public._fail('a note is required for this variance'); end if;
  end if;
  v_expected := public._shift_expected_cash(v_shift.id);
  update public.shifts set
    status = 'closed',
    closed_at = coalesce((p->>'closed_at')::timestamptz, now()),
    closed_by_staff_id = (select id from public.staff where id = (p->>'closed_by_staff_id')::uuid and business_id = v_shift.business_id),
    counted_cash_centavos = v_counted,
    counted_denoms = p->'counted_denoms',
    expected_cash_device_centavos = v_device_expected,
    expected_cash_centavos = v_expected,
    variance_centavos = v_counted - coalesce(v_device_expected, v_expected),
    variance_note = nullif(trim(p->>'variance_note'), ''),
    variance_approved_by_staff_id = (select id from public.staff where id = (p->>'approved_by_staff_id')::uuid and business_id = v_shift.business_id),
    closed_synced_at = now()
  where id = v_shift.id;
  return jsonb_build_object('status', 'ok', 'id', v_shift.id, 'expected_cash_centavos', v_expected);
end $$;

-- Orders carry their shift. Wraps record_sale so its body isn't restated.
alter function public.record_sale(jsonb) rename to _record_sale_v3;
create or replace function public.record_sale(p_sale jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb := public._record_sale_v3(p_sale);
  v_shift uuid := nullif(p_sale->>'shift_id', '')::uuid;
  v_id uuid := (p_sale->>'id')::uuid;
begin
  if v_result->>'status' = 'ok' and v_shift is not null then
    if exists (select 1 from public.shifts s join public.transactions t on t.business_id = s.business_id
               where s.id = v_shift and t.id = v_id) then
      update public.transactions set shift_id = v_shift where id = v_id;
    else
      update public.transactions set flags = array_append(flags, 'shift_missing') where id = v_id;
    end if;
  end if;
  return v_result;
end $$;

-- Shift report from server data: the same figures the tablet shows.
create or replace function public.shift_report(p_shift_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_shift public.shifts;
begin
  select * into v_shift from public.shifts where id = p_shift_id;
  if v_shift.id is null then perform public._fail('shift not found'); end if;
  if not (public.is_owner(v_shift.business_id)
          or v_shift.device_id in (select id from public.pos_devices where device_user_id = auth.uid())) then
    raise exception 'owner access required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'shift', to_jsonb(v_shift) || jsonb_build_object(
      'device_code', (select device_code from public.pos_devices where id = v_shift.device_id),
      'event_name', (select name from public.events where id = v_shift.event_id),
      'opened_by', (select name from public.staff where id = v_shift.opened_by_staff_id),
      'closed_by', (select name from public.staff where id = v_shift.closed_by_staff_id),
      'approved_by', (select name from public.staff where id = v_shift.variance_approved_by_staff_id)),
    'orders', (select count(*) from public.transactions where shift_id = p_shift_id and status = 'completed'),
    'gross_sales_centavos', coalesce((select sum(subtotal_centavos) from public.transactions where shift_id = p_shift_id and status = 'completed'), 0),
    'discounts_centavos', coalesce((select sum(discount_centavos) from public.transactions where shift_id = p_shift_id and status = 'completed'), 0),
    'voids', jsonb_build_object(
      'count', (select count(*) from public.transactions where shift_id = p_shift_id and status = 'voided'),
      'total_centavos', coalesce((select sum(total_centavos) from public.transactions where shift_id = p_shift_id and status = 'voided'), 0)),
    'refunds', jsonb_build_object(
      'count', (select count(*) from public.refunds where shift_id = p_shift_id),
      'total_centavos', coalesce((select sum(amount_centavos) from public.refunds where shift_id = p_shift_id), 0),
      'cash_centavos', coalesce((select sum(amount_centavos) from public.refunds where shift_id = p_shift_id and method = 'cash'), 0)),
    'net_sales_centavos',
      coalesce((select sum(total_centavos) from public.transactions where shift_id = p_shift_id and status = 'completed'), 0)
      - coalesce((select sum(amount_centavos) from public.refunds where shift_id = p_shift_id), 0),
    'by_method', jsonb_build_object(
      'cash_centavos', coalesce((select sum(total_centavos) from public.transactions where shift_id = p_shift_id and status = 'completed' and payment_method = 'cash'), 0),
      'qr_centavos', coalesce((select sum(total_centavos) from public.transactions where shift_id = p_shift_id and status = 'completed' and payment_method = 'qr_ph'), 0)),
    'qr_awaiting', jsonb_build_object(
      'count', (select count(*) from public.transactions where shift_id = p_shift_id and status = 'completed' and payment_status = 'awaiting_verification'),
      'total_centavos', coalesce((select sum(total_centavos) from public.transactions where shift_id = p_shift_id and status = 'completed' and payment_status = 'awaiting_verification'), 0)),
    'drawer', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'amount_centavos', m.amount_centavos, 'reason', m.reason,
             'at', m.created_at_device, 'staff', st.name, 'approved_by', ap.name) order by m.created_at_device)
      from public.drawer_movements m
      left join public.staff st on st.id = m.staff_id left join public.staff ap on ap.id = m.approved_by_staff_id
      where m.shift_id = p_shift_id), '[]'::jsonb),
    'expected_cash_centavos', public._shift_expected_cash(p_shift_id),
    'counted_cash_centavos', v_shift.counted_cash_centavos,
    'variance_centavos', case when v_shift.counted_cash_centavos is null then null
                              else v_shift.counted_cash_centavos - public._shift_expected_cash(p_shift_id) end,
    'top_items', coalesce((
      select jsonb_agg(x order by x.quantity desc, x.name) from (
        select l.name_snapshot as name, sum(l.quantity) as quantity, sum(l.line_total_centavos) as revenue_centavos
        from public.transaction_lines l join public.transactions t on t.id = l.transaction_id
        where t.shift_id = p_shift_id and t.status = 'completed'
        group by l.name_snapshot order by sum(l.quantity) desc, l.name_snapshot limit 10) x), '[]'::jsonb),
    'cashiers', coalesce((
      select jsonb_agg(distinct st.name) from public.transactions t join public.staff st on st.id = t.staff_id
      where t.shift_id = p_shift_id), '[]'::jsonb)
  );
end $$;

-- Event-level cash includes drawer movements from every shift in the event.
create or replace function public._event_drawer_net(p_event_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when m.kind = 'cash_in' then m.amount_centavos else -m.amount_centavos end), 0)
  from public.drawer_movements m join public.shifts s on s.id = m.shift_id where s.event_id = p_event_id;
$$;

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
                   where event_id = p_event_id and status = 'completed' and payment_method = 'cash'), 0)
       - public._cash_refunds(p_event_id)
       + public._event_drawer_net(p_event_id);
end $$;

alter function public.event_report(uuid) rename to _event_report_v2;
create or replace function public.event_report(p_event_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_base jsonb := public._event_report_v2(p_event_id); -- checks owner access
  v_drawer bigint := public._event_drawer_net(p_event_id);
begin
  return v_base || jsonb_build_object('cash', (v_base->'cash') || jsonb_build_object(
    'drawer_net_centavos', v_drawer,
    'expected_cash_centavos', (v_base->'cash'->>'expected_cash_centavos')::bigint + v_drawer));
end $$;

-- The tablet needs the variance threshold.
alter function public.pos_snapshot(uuid) rename to _pos_snapshot_v4;
create or replace function public.pos_snapshot(p_event_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_base jsonb := public._pos_snapshot_v4(p_event_id);
begin
  return v_base || jsonb_build_object('business', (v_base->'business') || jsonb_build_object(
    'variance_threshold_centavos',
    (select variance_threshold_centavos from public.businesses where id = (v_base->'business'->>'id')::uuid)));
end $$;

revoke all on function public._caller_device(uuid), public._shift_expected_cash(uuid), public._event_drawer_net(uuid),
  public._record_sale_v3(jsonb), public._event_report_v2(uuid), public._pos_snapshot_v4(uuid)
  from public, anon, authenticated;
revoke all on function public.open_shift(jsonb), public.close_shift(jsonb), public.record_drawer_movement(jsonb),
  public.shift_report(uuid), public.record_sale(jsonb), public.event_report(uuid), public.pos_snapshot(uuid)
  from public, anon;
grant execute on function public.open_shift(jsonb), public.close_shift(jsonb), public.record_drawer_movement(jsonb),
  public.shift_report(uuid), public.record_sale(jsonb), public.event_report(uuid), public.pos_snapshot(uuid)
  to authenticated;
