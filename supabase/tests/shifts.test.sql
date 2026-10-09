begin;
\ir _setup.sql
insert into ctx values ('owner_staff_a', (select id from public.staff where user_id = pg_temp.ctx('owner_a')));

select pg_temp.login(pg_temp.ctx('device_a'));
select public.claim_device_code();

create function pg_temp.open(p_id uuid, p_float bigint) returns jsonb language sql as $$
  select public.open_shift(jsonb_build_object('id', p_id, 'event_id', pg_temp.ctx('event_a'), 'opened_at', now(),
    'opened_by_staff_id', pg_temp.ctx('staff_a'), 'opening_float_centavos', p_float, 'opening_denoms', '{"b1000":1}'::jsonb));
$$;

-- 1. Opening is idempotent; one open shift per tablet (a stale one is closed off and noted).
select pg_temp.check(pg_temp.open('5f000000-0000-4000-8000-000000000001', 100000)->>'status' = 'ok', 'open');
select pg_temp.check(pg_temp.open('5f000000-0000-4000-8000-000000000001', 100000)->>'status' = 'duplicate', 'open idempotent');
select pg_temp.check(pg_temp.open('5f000000-0000-4000-8000-000000000002', 100000)->>'status' = 'ok', 'second open');
select pg_temp.check((select status = 'closed' and close_note like 'Closed automatically%' from public.shifts
  where id = '5f000000-0000-4000-8000-000000000001'), 'stale shift closed off');
select pg_temp.check((select count(*) from public.shifts where status = 'open') = 1, 'one open shift');

-- 2. Orders carry their shift; an unknown shift is flagged, never rejected.
select public.record_sale(pg_temp.sample_sale('5a000000-0000-4000-8000-000000000001', 1) || '{"shift_id":"5f000000-0000-4000-8000-000000000002"}'); -- cash 74500
select public.record_sale(pg_temp.sample_sale('5a000000-0000-4000-8000-000000000002', 2) || '{"shift_id":"5f000000-0000-4000-8000-000000000002"}'); -- cash 84000
select public.record_sale(
  pg_temp.sample_sale('5a000000-0000-4000-8000-000000000003', 1)
  || jsonb_build_object('shift_id', '5f000000-0000-4000-8000-000000000002', 'payment_method', 'qr_ph', 'qr_reference', '700',
                        'cash_received_centavos', null, 'change_given_centavos', null)); -- QR 74500
select public.record_sale(pg_temp.sample_sale('5a000000-0000-4000-8000-000000000004', 1) || '{"shift_id":"5f000000-0000-4000-8000-0000000000ff"}');
select pg_temp.check((select shift_id from public.transactions where id = '5a000000-0000-4000-8000-000000000001') = '5f000000-0000-4000-8000-000000000002', 'shift stored');
select pg_temp.check((select shift_id is null and 'shift_missing' = any(flags) from public.transactions where id = '5a000000-0000-4000-8000-000000000004'), 'unknown shift flagged');

-- 3. A void, a cash refund, cash in and cash out (owner approval needed for cash out).
select public.void_order(jsonb_build_object('transaction_id', '5a000000-0000-4000-8000-000000000001', 'reason_code', 'duplicate',
  'approved_by_staff_id', pg_temp.ctx('owner_staff_a')));
select pg_temp.logout();
insert into ctx values ('line2', (select id from public.transaction_lines where transaction_id = '5a000000-0000-4000-8000-000000000002' and kind = 'product'));
select pg_temp.login(pg_temp.ctx('device_a'));
select public.refund_order(jsonb_build_object('id', '5b000000-0000-4000-8000-000000000001', 'transaction_id', '5a000000-0000-4000-8000-000000000002',
  'method', 'cash', 'reason_code', 'changed_mind', 'approved_by_staff_id', pg_temp.ctx('owner_staff_a'), 'shift_id', '5f000000-0000-4000-8000-000000000002',
  'lines', jsonb_build_array(jsonb_build_object('transaction_line_id', pg_temp.ctx('line2'), 'quantity', 1)))); -- 9500
select public.record_drawer_movement(jsonb_build_object('id', '5c000000-0000-4000-8000-000000000001', 'shift_id', '5f000000-0000-4000-8000-000000000002',
  'kind', 'cash_in', 'amount_centavos', 10000, 'reason', 'extra float', 'staff_id', pg_temp.ctx('staff_a')));
do $$ begin
  begin
    perform public.record_drawer_movement(jsonb_build_object('id', '5c000000-0000-4000-8000-000000000002', 'shift_id', '5f000000-0000-4000-8000-000000000002',
      'kind', 'cash_out', 'amount_centavos', 5000, 'reason', 'ice supplier', 'staff_id', pg_temp.ctx('staff_a')));
    raise exception 'ASSERTION FAILED: cash out without owner';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select public.record_drawer_movement(jsonb_build_object('id', '5c000000-0000-4000-8000-000000000002', 'shift_id', '5f000000-0000-4000-8000-000000000002',
  'kind', 'cash_out', 'amount_centavos', 5000, 'reason', 'ice supplier', 'staff_id', pg_temp.ctx('staff_a'), 'approved_by_staff_id', pg_temp.ctx('owner_staff_a')));
select pg_temp.check(public.record_drawer_movement(jsonb_build_object('id', '5c000000-0000-4000-8000-000000000002', 'shift_id', '5f000000-0000-4000-8000-000000000002',
  'kind', 'cash_out', 'amount_centavos', 5000, 'reason', 'x', 'approved_by_staff_id', pg_temp.ctx('owner_staff_a')))->>'status' = 'duplicate', 'movement idempotent');

-- expected = 100000 float + 84000 cash sales − 9500 cash refund + 10000 in − 5000 out = 179500
select pg_temp.logout();
select pg_temp.check(public._shift_expected_cash('5f000000-0000-4000-8000-000000000002') = 179500, 'expected cash formula');
select pg_temp.login(pg_temp.ctx('device_a'));

-- 4. Close: a variance over ₱50 needs an owner and a note.
create function pg_temp.close(p_counted bigint, p_approver uuid, p_note text) returns jsonb language sql as $$
  select public.close_shift(jsonb_build_object('id', '5f000000-0000-4000-8000-000000000002', 'closed_at', now(),
    'closed_by_staff_id', pg_temp.ctx('staff_a'), 'counted_cash_centavos', p_counted, 'expected_cash_centavos', 179500,
    'approved_by_staff_id', p_approver, 'variance_note', p_note, 'counted_denoms', '{"b1000":1}'::jsonb));
$$;
do $$ begin
  begin
    perform pg_temp.close(169500, null, null); -- ₱100 short
    raise exception 'ASSERTION FAILED: big variance closed without approval';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
  begin
    perform pg_temp.close(169500, pg_temp.ctx('owner_staff_a'), '  ');
    raise exception 'ASSERTION FAILED: big variance closed without a note';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select pg_temp.check(pg_temp.close(169500, pg_temp.ctx('owner_staff_a'), 'miscounted change')->>'status' = 'ok', 'closed with approval');
select pg_temp.check(pg_temp.close(169500, null, null)->>'status' = 'duplicate', 'close idempotent');
select pg_temp.check((select variance_centavos = -10000 and expected_cash_centavos = 179500 and status = 'closed'
  from public.shifts where id = '5f000000-0000-4000-8000-000000000002'), 'variance stored');

-- 5. The shift report matches.
select pg_temp.login(pg_temp.ctx('owner_a'));
create temp table r as select public.shift_report('5f000000-0000-4000-8000-000000000002') as j;
grant select on r to authenticated;
select pg_temp.check((select (j->>'orders')::int = 2 from r), 'orders');
select pg_temp.check((select (j->'voids'->>'count')::int = 1 and (j->'voids'->>'total_centavos')::bigint = 74500 from r), 'voids');
select pg_temp.check((select (j->'refunds'->>'total_centavos')::bigint = 9500 from r), 'refunds');
select pg_temp.check((select (j->>'net_sales_centavos')::bigint = 84000 + 74500 - 9500 from r), 'net sales');
select pg_temp.check((select (j->'by_method'->>'qr_centavos')::bigint = 74500 and (j->'qr_awaiting'->>'count')::int = 1 from r), 'qr awaiting');
select pg_temp.check((select (j->>'variance_centavos')::bigint = -10000 and jsonb_array_length(j->'drawer') = 2 from r), 'variance and drawer');
select pg_temp.check((select j->'shift'->>'approved_by' = 'Owner A' and j->'cashiers' = '["Staff One"]'::jsonb from r), 'names');
select pg_temp.check((select j->'top_items'->0->>'name' = 'Butter Croissant' and (j->'top_items'->0->>'quantity')::int = 3 from r), 'top items');

-- 6. Event cash includes drawer movements; another business can't read the shift.
select pg_temp.check(public.expected_cash(pg_temp.ctx('event_a')) = 0 + (84000 + 74500) - 9500 + 10000 - 5000, 'event expected cash');
select pg_temp.login(pg_temp.ctx('owner_b'));
select pg_temp.check((select count(*) from public.shifts) = 0, 'other owner sees no shifts');
rollback;
