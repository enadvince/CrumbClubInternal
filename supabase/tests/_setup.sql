-- Shared fixture, \ir-included by each test inside its own transaction.
create temp table ctx (k text primary key, v uuid);
grant select on ctx to authenticated, anon;

create function pg_temp.ctx(p text) returns uuid language sql as $$ select v from ctx where k = p $$;
create function pg_temp.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  if p_user is null then set local role anon; else set local role authenticated; end if;
end $$;
create function pg_temp.logout() returns void language plpgsql as $$
begin reset role; perform set_config('request.jwt.claim.sub', '', true); end $$;
create function pg_temp.check(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'ASSERTION FAILED: %', p_msg; end if; end $$;

do $$
declare
  v_owner_a uuid := gen_random_uuid(); v_owner_b uuid := gen_random_uuid(); v_device_a uuid := gen_random_uuid();
  v_biz_a uuid; v_biz_b uuid; v_event uuid;
begin
  insert into auth.users (id, email) values (v_owner_a, 'a@test'), (v_owner_b, 'b@test'), (v_device_a, 'dev@test');
  v_biz_a := public._create_business_for(v_owner_a, 'Biz A', 'Owner A', '9001');
  v_biz_b := public._create_business_for(v_owner_b, 'Biz B', 'Owner B', '9002');
  insert into public.memberships (user_id, business_id, role) values (v_device_a, v_biz_a, 'device');
  v_event := public.load_sample_data(v_biz_a);
  perform public.load_sample_data(v_biz_b);
  update public.events set status = 'live' where id = v_event;
  insert into ctx values
    ('owner_a', v_owner_a), ('owner_b', v_owner_b), ('device_a', v_device_a),
    ('biz_a', v_biz_a), ('biz_b', v_biz_b), ('event_a', v_event),
    ('staff_a', (select id from public.staff where business_id = v_biz_a and name = 'Staff One')),
    ('ep_ube', (select ep.id from public.event_products ep join public.products p on p.id = ep.product_id
                where ep.event_id = v_event and p.name = 'Ube Croissant')),
    ('ep_butter', (select ep.id from public.event_products ep join public.products p on p.id = ep.product_id
                where ep.event_id = v_event and p.name = 'Butter Croissant')),
    ('eb_ube_box', (select eb.id from public.event_bundles eb join public.bundles b on b.id = eb.bundle_id
                where eb.event_id = v_event and b.name = 'Ube Box (6)'));
end $$;

-- Builds a sale: 1 Ube Box (₱650 → 6 ube @ ₱108.33.. allocated) + p_butter_qty butter croissants (cash).
create function pg_temp.sample_sale(p_id uuid, p_butter_qty int default 1, p_at timestamptz default now())
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'event_id', pg_temp.ctx('event_a'), 'staff_id', pg_temp.ctx('staff_a'),
    'client_created_at', p_at,
    'subtotal_centavos', 65000 + 9500 * p_butter_qty, 'discount_centavos', 0,
    'total_centavos', 65000 + 9500 * p_butter_qty,
    'payment_method', 'cash',
    'cash_received_centavos', 100000, 'change_given_centavos', 100000 - (65000 + 9500 * p_butter_qty),
    'lines', jsonb_build_array(
      jsonb_build_object(
        'id', gen_random_uuid(), 'kind', 'bundle',
        'bundle_id', (select bundle_id from public.event_bundles where id = pg_temp.ctx('eb_ube_box')),
        'event_bundle_id', pg_temp.ctx('eb_ube_box'), 'name_snapshot', 'Ube Box (6)',
        'quantity', 1, 'unit_price_centavos', 65000, 'line_total_centavos', 65000,
        'components', jsonb_build_array(jsonb_build_object(
          'event_product_id', pg_temp.ctx('ep_ube'),
          'product_id', (select product_id from public.event_products where id = pg_temp.ctx('ep_ube')),
          'quantity', 6, 'regular_unit_price_centavos', 12000,
          'allocated_revenue_centavos', 65000, 'allocated_discount_centavos', 0, 'unit_cost_centavos', 5000))),
      jsonb_build_object(
        'id', gen_random_uuid(), 'kind', 'product',
        'product_id', (select product_id from public.event_products where id = pg_temp.ctx('ep_butter')),
        'event_product_id', pg_temp.ctx('ep_butter'), 'name_snapshot', 'Butter Croissant',
        'quantity', p_butter_qty, 'unit_price_centavos', 9500, 'line_total_centavos', 9500 * p_butter_qty,
        'components', jsonb_build_array(jsonb_build_object(
          'event_product_id', pg_temp.ctx('ep_butter'),
          'product_id', (select product_id from public.event_products where id = pg_temp.ctx('ep_butter')),
          'quantity', p_butter_qty, 'regular_unit_price_centavos', 9500,
          'allocated_revenue_centavos', 9500 * p_butter_qty, 'allocated_discount_centavos', 0,
          'unit_cost_centavos', 3800))))
  );
$$;
