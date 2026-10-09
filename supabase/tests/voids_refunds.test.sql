begin;
\ir _setup.sql

insert into ctx values ('owner_staff_a', (select id from public.staff where user_id = pg_temp.ctx('owner_a')));

-- Refund amounts: cumulative floor, so partial refunds add up exactly.
select pg_temp.check(public._refund_amount(1000, 3, 0, 0, 1) = 333, 'first third');
select pg_temp.check(public._refund_amount(1000, 3, 1, 333, 1) = 333, 'second third');
select pg_temp.check(public._refund_amount(1000, 3, 2, 666, 1) = 334, 'last third takes the remainder');
select pg_temp.check(public._refund_amount(1000, 3, 0, 0, 3) = 1000, 'all at once');

select pg_temp.login(pg_temp.ctx('device_a'));
-- Sale 1: Ube Box + 2 butter (cash). Sale 2: Ube Box + 1 butter.
select public.record_sale(pg_temp.sample_sale('e0000000-0000-4000-8000-000000000001', 2));
select public.record_sale(pg_temp.sample_sale('e0000000-0000-4000-8000-000000000002', 1));
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_butter')) = 21, 'butter 21');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 12, 'ube 12');

-- 1. Voids need an owner's approval and a reason from the picklist.
do $$ begin
  begin
    perform public.void_order(jsonb_build_object('transaction_id', 'e0000000-0000-4000-8000-000000000002', 'reason_code', 'wrong_item',
      'approved_by_staff_id', pg_temp.ctx('staff_a')));
    raise exception 'ASSERTION FAILED: staff approved a void';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
  begin
    perform public.void_order(jsonb_build_object('transaction_id', 'e0000000-0000-4000-8000-000000000002', 'reason_code', 'other',
      'approved_by_staff_id', pg_temp.ctx('owner_staff_a')));
    raise exception 'ASSERTION FAILED: other without a note';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select pg_temp.check(public.void_order(jsonb_build_object('transaction_id', 'e0000000-0000-4000-8000-000000000002', 'reason_code', 'duplicate',
  'note', 'rang twice', 'staff_id', pg_temp.ctx('staff_a'), 'approved_by_staff_id', pg_temp.ctx('owner_staff_a')))->>'status' = 'ok', 'void ok');
select pg_temp.check((select status = 'voided' and void_reason = 'Duplicate: rang twice' and void_reason_code = 'duplicate'
  and voided_by_staff_id = pg_temp.ctx('owner_staff_a') and order_number is not null
  from public.transactions where id = 'e0000000-0000-4000-8000-000000000002'), 'voided, kept with its number');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 18, 'void returns ube');
select pg_temp.check(public.void_order(jsonb_build_object('transaction_id', 'e0000000-0000-4000-8000-000000000002', 'reason_code', 'duplicate',
  'approved_by_staff_id', pg_temp.ctx('owner_staff_a')))->>'status' = 'already_voided', 'void idempotent');

-- 2. Partial refund of one butter croissant (cash), resend is a no-op.
select pg_temp.logout();
insert into ctx values ('line_butter', (select id from public.transaction_lines where transaction_id = 'e0000000-0000-4000-8000-000000000001' and kind = 'product')),
                       ('line_box', (select id from public.transaction_lines where transaction_id = 'e0000000-0000-4000-8000-000000000001' and kind = 'bundle'));
select pg_temp.login(pg_temp.ctx('device_a'));
create function pg_temp.refund(p_id uuid, p_line uuid, p_qty int, p_amount bigint default null) returns jsonb language sql as $$
  select public.refund_order(jsonb_build_object('id', p_id, 'transaction_id', 'e0000000-0000-4000-8000-000000000001',
    'kind', 'refund', 'method', 'cash', 'reason_code', 'changed_mind', 'staff_id', pg_temp.ctx('staff_a'),
    'approved_by_staff_id', pg_temp.ctx('owner_staff_a'),
    'lines', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('transaction_line_id', p_line, 'quantity', p_qty, 'amount_centavos', p_amount)))));
$$;
select pg_temp.check(pg_temp.refund('f0000000-0000-4000-8000-000000000001', pg_temp.ctx('line_butter'), 1, 9500)->>'amount_centavos' = '9500', 'refund 1 butter');
select pg_temp.check(pg_temp.refund('f0000000-0000-4000-8000-000000000001', pg_temp.ctx('line_butter'), 1, 9500)->>'status' = 'duplicate', 'refund resend is a no-op');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_butter')) = 23, 'refund returns 1 butter (21 + void 1 + refund 1)');
select pg_temp.check((select refunded_centavos from public.transactions where id = 'e0000000-0000-4000-8000-000000000001') = 9500, 'refunded total');

-- 3. A wrong amount, or more than was sold, is rejected.
do $$ begin
  begin
    perform pg_temp.refund('f0000000-0000-4000-8000-000000000002', pg_temp.ctx('line_butter'), 1, 9000);
    raise exception 'ASSERTION FAILED: wrong amount accepted';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
  begin
    perform pg_temp.refund('f0000000-0000-4000-8000-000000000003', pg_temp.ctx('line_butter'), 2);
    raise exception 'ASSERTION FAILED: refunded more than sold';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

-- 4. Refunding a bundle returns all its components.
select pg_temp.refund('f0000000-0000-4000-8000-000000000004', pg_temp.ctx('line_box'), 1, 65000);
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 24, 'bundle refund returns 6 ube');

-- 5. An order with a refund can't then be voided; a voided order can't be refunded.
do $$ begin
  begin
    perform public.void_order(jsonb_build_object('transaction_id', 'e0000000-0000-4000-8000-000000000001', 'reason_code', 'wrong_item',
      'approved_by_staff_id', pg_temp.ctx('owner_staff_a')));
    raise exception 'ASSERTION FAILED: voided a refunded order';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

-- 6. Audit entries: idempotent, owners can read, the tablet can't.
select public.log_audit(jsonb_build_object('id', 'aa000000-0000-4000-8000-000000000001', 'action', 'refund',
  'transaction_id', 'e0000000-0000-4000-8000-000000000001', 'refund_id', 'f0000000-0000-4000-8000-000000000001',
  'amount_centavos', 9500, 'reason', 'changed_mind', 'cashier_staff_id', pg_temp.ctx('staff_a'),
  'manager_staff_id', pg_temp.ctx('owner_staff_a'), 'device_time', now() - interval '1 hour'));
select public.log_audit(jsonb_build_object('id', 'aa000000-0000-4000-8000-000000000001', 'action', 'refund'));
select pg_temp.check((select count(*) from public.audit_log) = 0, 'device cannot read the audit log');
select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check((select count(*) from public.audit_log) = 1, 'one audit entry');
select pg_temp.check((select manager_staff_id = pg_temp.ctx('owner_staff_a') and device_time < server_time and amount_centavos = 9500
  from public.audit_log), 'audit has manager, both times, amount');

-- 7. Reports net refunds; expected cash drops by cash refunds.
select pg_temp.check((public.event_report(pg_temp.ctx('event_a'))->'totals'->>'refunds_centavos')::bigint = 74500, 'event refunds');
select pg_temp.check((public.event_report(pg_temp.ctx('event_a'))->'cash'->>'cash_refunds_centavos')::bigint = 74500, 'cash refunds');
select pg_temp.check(public.expected_cash(pg_temp.ctx('event_a')) = 84000 - 74500, 'expected cash net of refunds');
select pg_temp.check((public.dashboard_report()->'refunds'->>'total_centavos')::bigint = 74500, 'dashboard refunds');

-- 8. Owner pages: void with an owner PIN and picklist reason is audited.
select public.record_sale(pg_temp.sample_sale('e0000000-0000-4000-8000-000000000003', 1));
do $$ begin
  begin
    perform public.void_order_with_owner_pin(jsonb_build_object('transaction_id', 'e0000000-0000-4000-8000-000000000003', 'reason_code', 'wrong_item'), '1111');
    raise exception 'ASSERTION FAILED: staff PIN voided';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select pg_temp.check(public.void_order_with_owner_pin(jsonb_build_object('transaction_id', 'e0000000-0000-4000-8000-000000000003',
  'reason_code', 'wrong_item'), '9001')->>'status' = 'ok', 'owner PIN void');
select pg_temp.check((select count(*) from public.audit_log where action = 'void' and transaction_id = 'e0000000-0000-4000-8000-000000000003') = 1, 'owner void audited');
rollback;
