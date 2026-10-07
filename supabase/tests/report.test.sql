begin;
\ir _setup.sql

select pg_temp.login(pg_temp.ctx('device_a'));
-- Two cash sales and one discounted QR sale, one voided sale
select public.record_sale(pg_temp.sample_sale('c0000000-0000-4000-8000-000000000001', 1));
select public.record_sale(pg_temp.sample_sale('c0000000-0000-4000-8000-000000000002', 2));
do $$
declare v jsonb := pg_temp.sample_sale('c0000000-0000-4000-8000-000000000003', 1);
begin
  -- 10% off ₱745 = ₱74.50, allocated 6500 + 950 across the two components
  v := v || '{"payment_method":"qr_ph","qr_reference":"QR1","cash_received_centavos":null,"change_given_centavos":null,
             "discount_type":"percent","discount_value":1000,"discount_centavos":7450,"discount_reason":"Promo","total_centavos":67050}';
  v := jsonb_set(v, '{lines,0,components,0,allocated_discount_centavos}', '6500');
  v := jsonb_set(v, '{lines,1,components,0,allocated_discount_centavos}', '950');
  perform public.record_sale(v);
end $$;
select public.record_sale(pg_temp.sample_sale('c0000000-0000-4000-8000-000000000004', 1));
select public.void_sale('c0000000-0000-4000-8000-000000000004', 'staff undo', null, now());

select pg_temp.login(pg_temp.ctx('owner_a'));
select public.set_opening_float(pg_temp.ctx('event_a'), 100000);
select public.adjust_stock(jsonb_build_object('event_product_id', pg_temp.ctx('ep_butter'), 'quantity_change', -2, 'reason', 'waste'));

do $$
declare r jsonb := public.event_report(pg_temp.ctx('event_a'));
declare v_product_revenue bigint;
begin
  perform pg_temp.check((r->'totals'->>'transactions')::int = 3, 'three completed');
  perform pg_temp.check((r->'totals'->>'voided')::int = 1, 'one voided');
  perform pg_temp.check((r->'totals'->>'revenue_centavos')::bigint = 74500 + 84000 + 67050, 'revenue net of discount');
  perform pg_temp.check((r->'totals'->>'discount_centavos')::bigint = 7450, 'discount total');
  perform pg_temp.check((r->'totals'->>'qr_centavos')::bigint = 67050, 'qr total');
  select sum((p->>'revenue_centavos')::bigint) into v_product_revenue from jsonb_array_elements(r->'products') p;
  perform pg_temp.check(v_product_revenue = (r->'totals'->>'revenue_centavos')::bigint, 'product revenue sums to total revenue');
  perform pg_temp.check((r->'cash'->>'expected_cash_centavos')::bigint = 100000 + 74500 + 84000, 'expected cash');
  perform pg_temp.check((select (p->>'waste_cost_centavos')::bigint from jsonb_array_elements(r->'products') p where p->>'name' = 'Butter Croissant') = 7600, 'waste cost');
  perform pg_temp.check((select (p->>'sold_in_bundles')::int from jsonb_array_elements(r->'products') p where p->>'name' = 'Ube Croissant') = 18, 'ube sold in bundles');
  perform pg_temp.check(jsonb_array_length(r->'qr_payments') = 1, 'qr list');
  perform pg_temp.check((r->'bundles'->0->>'units')::int = 3, 'bundle units');
end $$;

-- Staff device cannot read the owner report
select pg_temp.login(pg_temp.ctx('device_a'));
do $$ begin
  begin
    perform public.event_report(pg_temp.ctx('event_a'));
    raise exception 'ASSERTION FAILED: device read report';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
