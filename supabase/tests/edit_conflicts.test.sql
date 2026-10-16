begin;
\ir _setup.sql

-- Owner pages save only if updated_at is still what they saw (compare-and-set). updated_at must
-- move on owner edits (and the tablet's sold-out toggle), but not on sales: stock is
-- recalculated on every sale and must never look like "someone else changed it".
create function pg_temp.reset_ts() returns void language sql as $$
  update public.event_products set updated_at = '2000-01-01' where id = pg_temp.ctx('ep_butter');
  update public.events set updated_at = '2000-01-01' where id = pg_temp.ctx('event_a');
  update public.event_bundles set updated_at = '2000-01-01' where id = pg_temp.ctx('eb_ube_box');
$$;
create function pg_temp.ep_touched() returns boolean language sql as $$
  select updated_at > '2000-01-02' from public.event_products where id = pg_temp.ctx('ep_butter') $$;

-- 1. A sale changes stock but is not an edit.
select pg_temp.reset_ts();
select pg_temp.login(pg_temp.ctx('device_a'));
select public.record_sale(pg_temp.sample_sale('e1000000-0000-4000-8000-000000000001', 2));
select pg_temp.logout();
select pg_temp.check((select current_stock < starting_stock from public.event_products where id = pg_temp.ctx('ep_butter')), 'sale moved stock');
select pg_temp.check(not pg_temp.ep_touched(), 'sale did not bump event_products.updated_at');
select pg_temp.check((select updated_at = '2000-01-01' from public.events where id = pg_temp.ctx('event_a')), 'sale did not bump events.updated_at');

-- 2. The tablet marking an item sold out is a real change.
select pg_temp.login(pg_temp.ctx('device_a'));
select public.set_availability(pg_temp.ctx('ep_butter'), false);
select pg_temp.logout();
select pg_temp.check(pg_temp.ep_touched(), 'sold-out toggle bumps updated_at');

-- 3. Owner edits bump it; a stale compare-and-set then matches nothing.
select pg_temp.reset_ts();
select pg_temp.login(pg_temp.ctx('owner_a'));
update public.event_products set price_centavos = price_centavos + 500 where id = pg_temp.ctx('ep_butter');
select pg_temp.check(pg_temp.ep_touched(), 'price edit bumps updated_at');
with stale as (
  update public.event_products set price_centavos = 1 where id = pg_temp.ctx('ep_butter') and updated_at = '2000-01-01' returning 1
) select pg_temp.check((select count(*) = 0 from stale), 'stale save matches nothing');
update public.event_bundles set price_centavos = price_centavos + 100 where id = pg_temp.ctx('eb_ube_box');
select pg_temp.check((select updated_at > '2000-01-02' from public.event_bundles where id = pg_temp.ctx('eb_ube_box')), 'bundle price edit bumps updated_at');
update public.events set name = name || ' (edited)' where id = pg_temp.ctx('event_a');
select pg_temp.check((select updated_at > '2000-01-02' from public.events where id = pg_temp.ctx('event_a')), 'event details edit bumps updated_at');

-- 4. Going live / closing is not a details edit.
-- (set_event_status / close_event write status, went_live_at, closed_at: none of the touched columns.)
select pg_temp.logout();
update public.events set updated_at = '2000-01-01' where id = pg_temp.ctx('event_a');
update public.events set status = 'closed', closed_at = now() where id = pg_temp.ctx('event_a');
select pg_temp.check((select updated_at = '2000-01-01' from public.events where id = pg_temp.ctx('event_a')), 'status change did not bump events.updated_at');
select pg_temp.login(pg_temp.ctx('owner_a'));

-- 5. Discounts bump on any edit.
insert into public.discount_options (business_id, name, type, value, updated_at) values (pg_temp.ctx('biz_a'), 'Test', 'percent', 1000, '2000-01-01');
update public.discount_options set value = 1500 where business_id = pg_temp.ctx('biz_a') and name = 'Test';
select pg_temp.check((select updated_at > '2000-01-02' from public.discount_options where business_id = pg_temp.ctx('biz_a') and name = 'Test'), 'discount edit bumps updated_at');
select pg_temp.logout();
rollback;
