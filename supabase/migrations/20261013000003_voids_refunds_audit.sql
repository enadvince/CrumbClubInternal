-- Owner-approved voids and refunds, and an append-only audit log. All of it can be
-- done on the tablet offline: an owner PIN is checked on the tablet, the action is
-- queued with its own client id, and these RPCs apply it idempotently on sync.
-- (Owners are the "managers" here: owner and staff roles are unchanged.)

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  action text not null check (action in (
    'void', 'void_line', 'refund', 'pin_override', 'cash_in', 'cash_out', 'shift_close_variance',
    'reports_access', 'export', 'emergency_export', 'device_register', 'pin_lockout', 'payment_verified'
  )),
  -- No foreign key: an entry must never fail to sync because its order failed to.
  transaction_id uuid,
  order_number text,
  refund_id uuid,
  shift_id uuid,
  items jsonb,
  amount_centavos bigint,
  reason text,
  note text,
  cashier_staff_id uuid references public.staff (id) on delete set null,
  manager_staff_id uuid references public.staff (id) on delete set null,
  device_id uuid references public.pos_devices (id) on delete set null,
  device_user_id uuid,
  device_time timestamptz,
  server_time timestamptz not null default now()
);
create index audit_log_business_time_idx on public.audit_log (business_id, server_time desc);
create index audit_log_txn_idx on public.audit_log (transaction_id);

alter table public.audit_log enable row level security;
create policy audit_log_owner_select on public.audit_log
  for select to authenticated using (public.is_owner(business_id));
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

-- Internal append (idempotent on id).
create or replace function public._audit(p_business uuid, p_entry jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (
    id, business_id, action, transaction_id, order_number, refund_id, shift_id, items, amount_centavos,
    reason, note, cashier_staff_id, manager_staff_id, device_id, device_user_id, device_time
  ) values (
    coalesce((p_entry->>'id')::uuid, gen_random_uuid()), p_business, p_entry->>'action',
    (p_entry->>'transaction_id')::uuid, nullif(p_entry->>'order_number', ''), (p_entry->>'refund_id')::uuid,
    (p_entry->>'shift_id')::uuid, p_entry->'items', (p_entry->>'amount_centavos')::bigint,
    nullif(trim(p_entry->>'reason'), ''), nullif(trim(p_entry->>'note'), ''),
    (select id from public.staff where id = (p_entry->>'cashier_staff_id')::uuid and business_id = p_business),
    (select id from public.staff where id = (p_entry->>'manager_staff_id')::uuid and business_id = p_business),
    (select id from public.pos_devices where device_user_id = auth.uid() and business_id = p_business),
    auth.uid(), coalesce((p_entry->>'device_time')::timestamptz, now())
  ) on conflict (id) do nothing;
end $$;

-- Called by the tablet (queued offline) or owner pages.
create or replace function public.log_audit(p_entry jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_business uuid;
begin
  select business_id into v_business from public.memberships where user_id = auth.uid() order by created_at limit 1;
  if v_business is null then raise exception 'not a member of any business' using errcode = '42501'; end if;
  if (p_entry->>'id') is null then perform public._fail('audit entry id required'); end if;
  perform public._audit(v_business, p_entry);
  return jsonb_build_object('status', 'ok');
end $$;

-- An owner who approves something on the tablet must be an active owner of that business
-- (a deactivated co-owner can no longer approve).
create or replace function public._require_owner_staff(p_business uuid, p_staff uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.staff where id = p_staff and business_id = p_business and role = 'owner' and active) then
    perform public._fail('an owner must approve this');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Voids with a reason from the picklist. Never deletes; stock comes back.
-- ---------------------------------------------------------------------------
alter table public.transactions
  add column void_reason_code text check (void_reason_code in ('wrong_item', 'changed_mind', 'duplicate', 'other', 'staff_undo')),
  add column void_note text,
  add column refunded_centavos bigint not null default 0 check (refunded_centavos >= 0);

-- p: { transaction_id, reason_code, note, staff_id (cashier), approved_by_staff_id (owner), voided_at }
create or replace function public.void_order(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_txn public.transactions;
  v_role public.member_role;
  v_code text := p->>'reason_code';
  v_approver uuid := (p->>'approved_by_staff_id')::uuid;
  v_label text;
begin
  select * into v_txn from public.transactions where id = (p->>'transaction_id')::uuid for update;
  if v_txn.id is null then perform public._fail('order not found; it must sync before it can be voided'); end if;
  v_role := public.my_role(v_txn.business_id);
  if v_role is null then raise exception 'not a member of this business' using errcode = '42501'; end if;
  if v_txn.status = 'voided' then return jsonb_build_object('status', 'already_voided', 'id', v_txn.id); end if;
  if v_code is null or v_code not in ('wrong_item', 'changed_mind', 'duplicate', 'other') then
    perform public._fail('pick a void reason');
  end if;
  if v_code = 'other' and coalesce(trim(p->>'note'), '') = '' then perform public._fail('add a note for "other"'); end if;
  if v_txn.refunded_centavos > 0 then perform public._fail('this order already has a refund; refund the rest instead'); end if;
  if v_role = 'device' then
    perform public._require_owner_staff(v_txn.business_id, v_approver);
  else
    v_approver := coalesce(v_approver, public._my_staff_id(v_txn.business_id));
  end if;

  v_label := case v_code when 'wrong_item' then 'Wrong item' when 'changed_mind' then 'Customer changed mind'
                         when 'duplicate' then 'Duplicate' else 'Other' end;
  update public.transactions set
    status = 'voided',
    void_reason = v_label || coalesce(': ' || nullif(trim(p->>'note'), ''), ''),
    void_reason_code = v_code,
    void_note = nullif(trim(p->>'note'), ''),
    voided_at = coalesce((p->>'voided_at')::timestamptz, now()),
    voided_by_user_id = auth.uid(),
    voided_by_staff_id = v_approver
  where id = v_txn.id;
  return jsonb_build_object('status', 'ok', 'id', v_txn.id);
end $$;

-- Owner pages: void with an owner PIN now takes a picklist reason too.
create or replace function public.void_order_with_owner_pin(p jsonb, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_business uuid;
  v_staff uuid;
  v_result jsonb;
  v_txn public.transactions;
begin
  select * into v_txn from public.transactions where id = (p->>'transaction_id')::uuid;
  if v_txn.id is null then raise exception 'transaction not found' using errcode = 'P0002'; end if;
  v_business := v_txn.business_id;
  perform public._require_owner(v_business);
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then perform public._fail('Enter a 4-digit owner PIN'); end if;
  select s.id into v_staff from public.staff s
   where s.business_id = v_business and s.active and s.role = 'owner' and s.pin_hash is not null
     and extensions.crypt(p_pin, s.pin_hash) = s.pin_hash
   limit 1;
  if v_staff is null then perform public._fail('That isn''t an owner PIN'); end if;

  v_result := public.void_order(p || jsonb_build_object('approved_by_staff_id', v_staff, 'voided_at', now()));
  if v_result->>'status' = 'ok' then
    perform public._log_pin_use(gen_random_uuid(), v_business, v_staff, 'void_approval', now());
    perform public._audit(v_business, jsonb_build_object(
      'action', 'void', 'transaction_id', v_txn.id, 'order_number', v_txn.order_number,
      'amount_centavos', v_txn.total_centavos, 'reason', p->>'reason_code', 'note', p->>'note',
      'cashier_staff_id', v_txn.staff_id, 'manager_staff_id', v_staff));
  end if;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Refunds (full or partial by line and quantity) and line voids.
-- ---------------------------------------------------------------------------
create table public.refunds (
  id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  transaction_id uuid not null references public.transactions (id),
  event_id uuid not null references public.events (id),
  -- set by the shifts migration's foreign key
  shift_id uuid,
  device_id uuid references public.pos_devices (id) on delete set null,
  kind text not null check (kind in ('refund', 'line_void')),
  method public.payment_method not null,
  amount_centavos bigint not null check (amount_centavos > 0),
  reason_code text not null,
  note text,
  staff_id uuid references public.staff (id),
  approved_by_staff_id uuid not null references public.staff (id),
  created_at_device timestamptz not null,
  created_at timestamptz not null default now()
);
create index refunds_txn_idx on public.refunds (transaction_id);
create index refunds_event_idx on public.refunds (event_id);
create index refunds_business_time_idx on public.refunds (business_id, created_at desc);

create table public.refund_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  refund_id uuid not null references public.refunds (id) on delete cascade,
  transaction_line_id uuid not null references public.transaction_lines (id),
  quantity int not null check (quantity > 0),
  amount_centavos bigint not null check (amount_centavos >= 0)
);
create index refund_lines_refund_idx on public.refund_lines (refund_id);
create index refund_lines_line_idx on public.refund_lines (transaction_line_id);

-- Products that come back to stock (a bundle line expands to its components).
create table public.refund_components (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  refund_id uuid not null references public.refunds (id) on delete cascade,
  event_product_id uuid not null references public.event_products (id),
  product_id uuid not null references public.products (id),
  quantity int not null check (quantity > 0)
);
create index refund_components_ep_idx on public.refund_components (event_product_id);

alter table public.refunds enable row level security;
alter table public.refund_lines enable row level security;
alter table public.refund_components enable row level security;
create policy refunds_select on public.refunds for select to authenticated using (
  public.is_owner(business_id)
  or (public.is_member(business_id) and exists (select 1 from public.events e where e.id = event_id and e.status = 'live')));
create policy refund_lines_select on public.refund_lines for select to authenticated using (
  exists (select 1 from public.refunds r where r.id = refund_id));
create policy refund_components_select on public.refund_components for select to authenticated using (
  exists (select 1 from public.refunds r where r.id = refund_id));
revoke all on public.refunds, public.refund_lines, public.refund_components from anon, authenticated;
grant select on public.refunds, public.refund_lines, public.refund_components to authenticated;

-- How much k more units of a line refund, given what was refunded before. Cumulative
-- floor, so partial refunds always add up exactly to the line's net total. The tablet
-- uses the same rule (src/lib/pos/refund.ts).
create or replace function public._refund_amount(p_net bigint, p_qty int, p_prev_qty int, p_prev_amount bigint, p_k int)
returns bigint language sql immutable set search_path = public as $$
  select case when p_prev_qty + p_k >= p_qty then p_net - p_prev_amount
              else (p_net * (p_prev_qty + p_k)) / p_qty - p_prev_amount end;
$$;

-- p: { id, transaction_id, kind, method, reason_code, note, staff_id, approved_by_staff_id, shift_id,
--      created_at, amount_centavos, lines: [{ transaction_line_id, quantity, amount_centavos }] }
create or replace function public.refund_order(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p->>'id')::uuid;
  v_txn public.transactions;
  v_role public.member_role;
  v_approver uuid := (p->>'approved_by_staff_id')::uuid;
  v_kind text := coalesce(p->>'kind', 'refund');
  v_line jsonb;
  v_tl public.transaction_lines;
  v_k int;
  v_net bigint;
  v_prev_qty int;
  v_prev_amount bigint;
  v_amount bigint;
  v_total bigint := 0;
begin
  if v_id is null then perform public._fail('refund id required'); end if;
  if exists (select 1 from public.refunds where id = v_id) then
    return jsonb_build_object('status', 'duplicate', 'id', v_id);
  end if;

  select * into v_txn from public.transactions where id = (p->>'transaction_id')::uuid for update;
  if v_txn.id is null then perform public._fail('order not found; it must sync before it can be refunded'); end if;
  v_role := public.my_role(v_txn.business_id);
  if v_role is null then raise exception 'not a member of this business' using errcode = '42501'; end if;
  if v_txn.status <> 'completed' then perform public._fail('a voided order can''t be refunded'); end if;
  if v_kind not in ('refund', 'line_void') then perform public._fail('unknown refund kind'); end if;
  if coalesce(p->>'reason_code', '') = '' then perform public._fail('pick a reason'); end if;
  if v_role = 'device' then
    perform public._require_owner_staff(v_txn.business_id, v_approver);
  else
    v_approver := coalesce(v_approver, public._my_staff_id(v_txn.business_id));
  end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    perform public._fail('pick at least one item to refund');
  end if;

  insert into public.refunds (
    id, business_id, transaction_id, event_id, shift_id, device_id, kind, method, amount_centavos,
    reason_code, note, staff_id, approved_by_staff_id, created_at_device
  ) values (
    v_id, v_txn.business_id, v_txn.id, v_txn.event_id, (p->>'shift_id')::uuid,
    (select id from public.pos_devices where device_user_id = auth.uid()),
    v_kind, coalesce((p->>'method')::public.payment_method, v_txn.payment_method),
    greatest(1, coalesce((p->>'amount_centavos')::bigint, 1)), -- corrected below
    p->>'reason_code', nullif(trim(p->>'note'), ''),
    (select id from public.staff where id = (p->>'staff_id')::uuid and business_id = v_txn.business_id),
    v_approver, coalesce((p->>'created_at')::timestamptz, now())
  );

  for v_line in select * from jsonb_array_elements(p->'lines') loop
    select * into v_tl from public.transaction_lines
     where id = (v_line->>'transaction_line_id')::uuid and transaction_id = v_txn.id;
    if v_tl.id is null then perform public._fail('item is not on this order'); end if;
    v_k := (v_line->>'quantity')::int;
    select coalesce(sum(rl.quantity), 0), coalesce(sum(rl.amount_centavos), 0) into v_prev_qty, v_prev_amount
      from public.refund_lines rl where rl.transaction_line_id = v_tl.id;
    if v_k is null or v_k <= 0 or v_prev_qty + v_k > v_tl.quantity then
      perform public._fail('can''t refund more than was sold');
    end if;
    select v_tl.line_total_centavos - coalesce(sum(c.allocated_discount_centavos), 0) into v_net
      from public.transaction_line_components c where c.line_id = v_tl.id;
    v_amount := public._refund_amount(v_net, v_tl.quantity, v_prev_qty, v_prev_amount, v_k);
    if (v_line->>'amount_centavos') is not null and (v_line->>'amount_centavos')::bigint <> v_amount then
      perform public._fail(format('refund amount for %s should be %s centavos', v_tl.name_snapshot, v_amount));
    end if;
    insert into public.refund_lines (business_id, refund_id, transaction_line_id, quantity, amount_centavos)
    values (v_txn.business_id, v_id, v_tl.id, v_k, v_amount);
    -- Components scale exactly: each component quantity is a multiple of the line quantity.
    insert into public.refund_components (business_id, refund_id, event_product_id, product_id, quantity)
    select v_txn.business_id, v_id, c.event_product_id, c.product_id, (c.quantity * v_k) / v_tl.quantity
    from public.transaction_line_components c where c.line_id = v_tl.id and (c.quantity * v_k) / v_tl.quantity > 0;
    v_total := v_total + v_amount;
  end loop;

  if v_total <= 0 then perform public._fail('nothing left to refund on those items'); end if;
  if (p->>'amount_centavos') is not null and (p->>'amount_centavos')::bigint <> v_total then
    perform public._fail(format('refund total should be %s centavos', v_total));
  end if;
  update public.refunds set amount_centavos = v_total where id = v_id;
  update public.transactions set refunded_centavos = refunded_centavos + v_total where id = v_txn.id;
  return jsonb_build_object('status', 'ok', 'id', v_id, 'amount_centavos', v_total);
end $$;

-- ---------------------------------------------------------------------------
-- Stock ledger: refunded products come back. sold = sold in completed sales − refunded.
-- ---------------------------------------------------------------------------
create or replace function public._sold_qty(p_ep uuid)
returns bigint language sql stable set search_path = public as $$
  select coalesce((
    select sum(c.quantity) from public.transaction_line_components c
    join public.transactions t on t.id = c.transaction_id
    where c.event_product_id = p_ep and t.status = 'completed'), 0)
  - coalesce((
    select sum(rc.quantity) from public.refund_components rc
    join public.refunds r on r.id = rc.refund_id
    join public.transactions t on t.id = r.transaction_id
    where rc.event_product_id = p_ep and t.status = 'completed'), 0);
$$;

create or replace function public._tg_refund_components_stock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._refresh_stock(new.event_product_id);
  return null;
end $$;

create trigger refund_components_stock
  after insert on public.refund_components
  for each row execute function public._tg_refund_components_stock();

-- ---------------------------------------------------------------------------
-- Cash: refunds paid in cash reduce the cash expected in the drawer.
-- ---------------------------------------------------------------------------
create or replace function public._cash_refunds(p_event_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_centavos), 0) from public.refunds where event_id = p_event_id and method = 'cash';
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
       - public._cash_refunds(p_event_id);
end $$;

-- Event report: same as before plus refunds, with expected cash net of cash refunds.
alter function public.event_report(uuid) rename to _event_report_base;
create or replace function public.event_report(p_event_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_base jsonb := public._event_report_base(p_event_id); -- checks owner access
  v_refunds bigint;
  v_cash_refunds bigint := public._cash_refunds(p_event_id);
begin
  select coalesce(sum(amount_centavos), 0) into v_refunds from public.refunds where event_id = p_event_id;
  return v_base
    || jsonb_build_object('totals', (v_base->'totals') || jsonb_build_object(
         'refunds_centavos', v_refunds,
         'refund_count', (select count(*) from public.refunds where event_id = p_event_id),
         'net_revenue_centavos', (v_base->'totals'->>'revenue_centavos')::bigint - v_refunds))
    || jsonb_build_object('cash', (v_base->'cash') || jsonb_build_object(
         'cash_refunds_centavos', v_cash_refunds,
         'expected_cash_centavos', (v_base->'cash'->>'expected_cash_centavos')::bigint - v_cash_refunds))
    || jsonb_build_object('qr_payments', coalesce((
         select jsonb_agg(jsonb_build_object('id', id, 'time', client_created_at, 'reference', qr_reference,
                'amount_centavos', total_centavos, 'flags', flags, 'payment_status', payment_status,
                'order_number', order_number) order by client_created_at)
         from public.transactions where event_id = p_event_id and status = 'completed' and payment_method = 'qr_ph'
       ), '[]'::jsonb));
end $$;

-- Dashboard: same figures plus refunds on sales in the period.
alter function public.dashboard_report(timestamptz, timestamptz, uuid) rename to _dashboard_report_base;
create or replace function public.dashboard_report(
  p_from timestamptz default null, p_to timestamptz default null, p_event_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_base jsonb := public._dashboard_report_base(p_from, p_to, p_event_id); -- checks owner access
  v_business uuid;
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() and role = 'owner' order by created_at limit 1;
  return v_base || jsonb_build_object('refunds', (
    select jsonb_build_object('count', count(*), 'total_centavos', coalesce(sum(r.amount_centavos), 0))
    from public.refunds r join public.transactions t on t.id = r.transaction_id
    where r.business_id = v_business and t.status = 'completed'
      and (p_from is null or t.client_created_at >= p_from)
      and (p_to is null or t.client_created_at < p_to)
      and (p_event_id is null or r.event_id = p_event_id)));
end $$;

revoke all on function public._audit(uuid, jsonb), public._require_owner_staff(uuid, uuid),
  public._refund_amount(bigint, int, int, bigint, int), public._cash_refunds(uuid),
  public._tg_refund_components_stock(), public._event_report_base(uuid),
  public._dashboard_report_base(timestamptz, timestamptz, uuid)
  from public, anon, authenticated;
revoke all on function public.log_audit(jsonb), public.void_order(jsonb), public.void_order_with_owner_pin(jsonb, text),
  public.refund_order(jsonb), public.event_report(uuid), public.dashboard_report(timestamptz, timestamptz, uuid)
  from public, anon;
grant execute on function public.log_audit(jsonb), public.void_order(jsonb), public.void_order_with_owner_pin(jsonb, text),
  public.refund_order(jsonb), public.event_report(uuid), public.dashboard_report(timestamptz, timestamptz, uuid)
  to authenticated;
