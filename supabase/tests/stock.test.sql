begin;
\ir _setup.sql

-- Cookies are made to order: no stock tracking. Almonds warn at 15.
update public.products set track_stock = false where business_id = pg_temp.ctx('biz_a') and name = 'Brown Butter Cookie';
update public.products set low_stock_threshold = 15 where business_id = pg_temp.ctx('biz_a') and name = 'Almond Croissant';

select pg_temp.login(pg_temp.ctx('device_a'));
-- 1. The snapshot tells the tablet which products are tracked and their thresholds.
select pg_temp.check((select (p->>'track_stock')::boolean = false from jsonb_array_elements(public.pos_snapshot()->'products') p
  where p->>'name' = 'Brown Butter Cookie'), 'cookie untracked in snapshot');
select pg_temp.check((select (p->>'low_stock_threshold')::int = 15 from jsonb_array_elements(public.pos_snapshot()->'products') p
  where p->>'name' = 'Almond Croissant'), 'almond threshold in snapshot');
select pg_temp.check((select p ? 'stock' and p ? 'price_centavos' from jsonb_array_elements(public.pos_snapshot()->'products') p limit 1), 'base fields kept');

-- 2. Overselling a tracked product is recorded and flagged; untracked is not flagged.
select pg_temp.logout();
update public.event_products set starting_stock = 1 where id = pg_temp.ctx('ep_butter');
insert into ctx values ('ep_cookie', (select ep.id from public.event_products ep join public.products p on p.id = ep.product_id
  where ep.event_id = pg_temp.ctx('event_a') and p.name = 'Brown Butter Cookie'));
update public.event_products set starting_stock = 0 where id = pg_temp.ctx('ep_cookie');
select pg_temp.login(pg_temp.ctx('device_a'));
select public.record_sale(pg_temp.sample_sale('a1000000-0000-4000-8000-000000000001', 2));
select pg_temp.check((select 'oversold' = any(flags) from public.transactions where id = 'a1000000-0000-4000-8000-000000000001'), 'tracked oversell flagged');

create function pg_temp.cookie_sale(p_id uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'event_id', pg_temp.ctx('event_a'), 'staff_id', pg_temp.ctx('staff_a'), 'client_created_at', now(),
    'subtotal_centavos', 6500, 'discount_centavos', 0, 'total_centavos', 6500, 'payment_method', 'cash',
    'cash_received_centavos', 6500, 'change_given_centavos', 0,
    'lines', jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(), 'kind', 'product',
      'product_id', (select product_id from public.event_products where id = pg_temp.ctx('ep_cookie')),
      'event_product_id', pg_temp.ctx('ep_cookie'), 'name_snapshot', 'Cookie', 'quantity', 1,
      'unit_price_centavos', 6500, 'line_total_centavos', 6500,
      'components', jsonb_build_array(jsonb_build_object(
        'event_product_id', pg_temp.ctx('ep_cookie'),
        'product_id', (select product_id from public.event_products where id = pg_temp.ctx('ep_cookie')),
        'quantity', 1, 'regular_unit_price_centavos', 6500, 'allocated_revenue_centavos', 6500,
        'allocated_discount_centavos', 0, 'unit_cost_centavos', 2200)))));
$$;
select public.record_sale(pg_temp.cookie_sale('a1000000-0000-4000-8000-000000000002'));
select pg_temp.check((select not ('oversold' = any(flags)) from public.transactions where id = 'a1000000-0000-4000-8000-000000000002'), 'untracked not flagged');

-- 3. Owners get the low stock list: tracked products at or below their threshold.
select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check((select count(*) from jsonb_array_elements(public.low_stock_report()->'items') i where i->>'name' = 'Butter Croissant' and (i->>'out')::boolean) = 1, 'butter out');
select pg_temp.check((select count(*) from jsonb_array_elements(public.low_stock_report()->'items') i where i->>'name' = 'Almond Croissant') = 1, 'almond low at its own threshold (12 <= 15)');
select pg_temp.check((select count(*) from jsonb_array_elements(public.low_stock_report()->'items') i where i->>'name' = 'Brown Butter Cookie') = 0, 'untracked never listed');
select pg_temp.login(pg_temp.ctx('device_a'));
do $$ begin
  begin
    perform public.low_stock_report();
    raise exception 'ASSERTION FAILED: device read the low stock report';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
