begin;
\ir _setup.sql

select pg_temp.login(pg_temp.ctx('device_a'));

-- Starting stock: ube 24, butter 24
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 24, 'ube starts at 24');

-- 1. Record a sale with a bundle: components decrement stock
select pg_temp.check(public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000001', 2))->>'status' = 'ok', 'sale ok');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 18, 'bundle took 6 ube');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_butter')) = 22, 'took 2 butter');
select pg_temp.check((select item_count from public.transactions where id = 'a0000000-0000-4000-8000-000000000001') = 8, 'item count');
select pg_temp.check((select has_bundle from public.transactions where id = 'a0000000-0000-4000-8000-000000000001'), 'has_bundle');

-- 2. Retrying the same sale is a no-op (idempotent)
select pg_temp.check(public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000001', 2))->>'status' = 'duplicate', 'retry is duplicate');
select pg_temp.check((select count(*) from public.transactions) = 1, 'still one transaction');
select pg_temp.check((select count(*) from public.transaction_line_components) = 2, 'no duplicate components');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 18, 'stock unchanged on retry');

-- 3. Bad allocation is rejected
do $$
declare v jsonb := pg_temp.sample_sale('a0000000-0000-4000-8000-000000000002');
begin
  v := jsonb_set(v, '{lines,0,components,0,allocated_revenue_centavos}', '64999');
  begin
    perform public.record_sale(v);
    raise exception 'ASSERTION FAILED: bad allocation accepted';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select pg_temp.check((select count(*) from public.transactions) = 1, 'rejected sale not stored');

-- 4. Staff undo within window returns all component stock
select pg_temp.check(public.void_sale('a0000000-0000-4000-8000-000000000001', 'staff undo', pg_temp.ctx('staff_a'), now() + interval '30 seconds')->>'status' = 'ok', 'undo ok');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 24, 'ube returned');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_butter')) = 24, 'butter returned');
select pg_temp.check(public.void_sale('a0000000-0000-4000-8000-000000000001', 'staff undo')->>'status' = 'already_voided', 'void idempotent');
select pg_temp.check((select count(*) from public.transactions) = 1, 'voided sale not deleted');

-- 5. Undo outside window is refused
select public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000003', 1, now() - interval '10 minutes'));
do $$ begin
  begin
    perform public.void_sale('a0000000-0000-4000-8000-000000000003', 'staff undo', null, now());
    raise exception 'ASSERTION FAILED: late undo allowed';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

-- 6. Owner void works any time and returns stock
select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 18, 'ube 18 before owner void');
select public.void_sale('a0000000-0000-4000-8000-000000000003', 'wrong item rung up');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 24, 'owner void returns stock');
select pg_temp.check((select voided_by_staff_id from public.transactions where id = 'a0000000-0000-4000-8000-000000000003')
  = (select id from public.staff where user_id = pg_temp.ctx('owner_a')), 'voided_by owner staff');

-- 7. Restock adds without touching starting stock; idempotent
select public.adjust_stock(jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000001',
  'event_product_id', pg_temp.ctx('ep_ube'), 'quantity_change', 12, 'reason', 'restock'));
select public.adjust_stock(jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000001',
  'event_product_id', pg_temp.ctx('ep_ube'), 'quantity_change', 12, 'reason', 'restock'));
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 36, 'restock once');
select pg_temp.check((select starting_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 24, 'starting unchanged');

-- 8. Selling out sets sold_out_at; oversell is recorded and flagged
select pg_temp.login(pg_temp.ctx('device_a'));
select public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000004', 1, '2026-10-10 10:00+08'));
select public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000005', 1, '2026-10-10 10:05+08'));
select public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000006', 1, '2026-10-10 10:10+08'));
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 18, 'ube 18');
select public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000007', 1, '2026-10-10 10:15+08'));
select public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000008', 1, '2026-10-10 10:20+08'));
select public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000009', 1, '2026-10-10 11:40+08'));
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = 0, 'ube sold out');
select pg_temp.check((select sold_out_at from public.event_products where id = pg_temp.ctx('ep_ube')) = '2026-10-10 11:40+08', 'sold_out_at = last sale');
select pg_temp.check((public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000010', 1))->'flags') ? 'oversold', 'oversell flagged');
select pg_temp.check((select current_stock from public.event_products where id = pg_temp.ctx('ep_ube')) = -6, 'oversell recorded');

-- 9. Duplicate QR reference is flagged, not blocked
do $$
declare v jsonb := pg_temp.sample_sale('a0000000-0000-4000-8000-000000000011');
begin
  v := v || '{"payment_method":"qr_ph","qr_reference":"REF123","cash_received_centavos":null,"change_given_centavos":null}';
  perform public.record_sale(v);
  v := pg_temp.sample_sale('a0000000-0000-4000-8000-000000000012')
    || '{"payment_method":"qr_ph","qr_reference":"REF123","cash_received_centavos":null,"change_given_centavos":null}';
  perform pg_temp.check((public.record_sale(v)->'flags') ? 'duplicate_qr_ref', 'dup QR flagged');
end $$;

-- 10. Close: expected cash = float + cash sales; leftovers snapshotted; late sync flagged
select pg_temp.login(pg_temp.ctx('owner_a'));
select public.set_opening_float(pg_temp.ctx('event_a'), 200000);
do $$
declare v_expected bigint; v_res jsonb;
begin
  select 200000 + sum(total_centavos) into v_expected from public.transactions
   where event_id = pg_temp.ctx('event_a') and status = 'completed' and payment_method = 'cash';
  v_res := public.close_event(pg_temp.ctx('event_a'), v_expected - 500, 'short ₱5',
    jsonb_build_array(jsonb_build_object('event_product_id', pg_temp.ctx('ep_butter'), 'quantity', 2)));
  perform pg_temp.check((v_res->>'expected_cash_centavos')::bigint = v_expected, 'expected cash');
  perform pg_temp.check((v_res->>'variance_centavos')::bigint = -500, 'variance');
end $$;
select pg_temp.check((select closing_stock from public.event_products where id = pg_temp.ctx('ep_butter'))
  = (select current_stock from public.event_products where id = pg_temp.ctx('ep_butter')), 'closing stock snapshot');
select pg_temp.check((select count(*) from public.stock_adjustments where reason = 'waste') = 1, 'waste recorded');
select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.check((public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000013'))->'flags') ? 'late_sync', 'late sync accepted+flagged');
do $$ begin
  begin
    perform public.adjust_stock(jsonb_build_object('event_product_id', pg_temp.ctx('ep_ube'), 'quantity_change', 1, 'reason', 'restock'));
    raise exception 'ASSERTION FAILED: adjust after close';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

-- 11. Duplicate event copies the menu as a draft
select pg_temp.login(pg_temp.ctx('owner_a'));
do $$
declare v_new uuid;
begin
  v_new := public.duplicate_event(pg_temp.ctx('event_a'), 'Next Market', 'BGC', '2026-10-17', '2026-10-18');
  perform pg_temp.check((select count(*) from public.event_products where event_id = v_new) = 7, 'products copied');
  perform pg_temp.check((select count(*) from public.event_bundles where event_id = v_new) = 4, 'bundles copied');
  perform pg_temp.check((select current_stock from public.event_products where event_id = v_new
    and product_id = (select product_id from public.event_products where id = pg_temp.ctx('ep_ube')))
    = 24, 'fresh stock');
end $$;

-- 12. PIN rules
do $$ begin
  begin
    perform public.set_staff_pin(pg_temp.ctx('staff_a'), '2222');  -- Staff Two already has 2222
    raise exception 'ASSERTION FAILED: duplicate PIN allowed';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
  begin
    perform public.set_staff_pin(pg_temp.ctx('staff_a'), '12a4');
    raise exception 'ASSERTION FAILED: bad PIN allowed';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select public.change_staff_pin(pg_temp.ctx('staff_a'), '1111', '4321');

-- 13. Changing a PIN needs the current PIN
do $$ begin
  begin
    perform public.change_staff_pin(pg_temp.ctx('staff_a'), '0000', '5678');
    raise exception 'ASSERTION FAILED: wrong current PIN accepted';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
  begin
    perform public.set_staff_pin(pg_temp.ctx('staff_a'), '5678');
    raise exception 'ASSERTION FAILED: set_staff_pin overwrote an existing PIN';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select pg_temp.check((select extensions.crypt('4321', pin_hash) = pin_hash from public.staff where id = pg_temp.ctx('staff_a')),
  'PIN unchanged after failed attempts');
-- A person with no PIN yet can be given one without a current PIN
select pg_temp.logout();
update public.staff set pin_hash = null where id = pg_temp.ctx('staff_a');
select pg_temp.login(pg_temp.ctx('owner_a'));
select public.set_staff_pin(pg_temp.ctx('staff_a'), '5678');

rollback;
