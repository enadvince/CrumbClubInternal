begin;
\ir _setup.sql
grant select on ctx to service_role;

-- ---------------------------------------------------------------------------
-- Personnel: deactivate/reactivate (not the main owner) and remove (owner PIN).
-- ---------------------------------------------------------------------------
create function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '', true); set local role service_role; end $$;
create function pg_temp.expect_fail(p_sql text, p_msg text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then return;
  end;
  raise exception 'ASSERTION FAILED: %', p_msg;
end $$;

do $$
declare v_co uuid := gen_random_uuid(); v_co2 uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_co, 'co@test.com'), (v_co2, 'co2@test.com');
  insert into ctx values ('co', v_co), ('co2', v_co2);
end $$;

select pg_temp.login(pg_temp.ctx('owner_a'));
select public.add_co_owner('co@test.com', 'Co', '4321');
select public.add_co_owner('co2@test.com', 'Co Two', '4322');
select pg_temp.logout();
insert into ctx values
  ('main_staff', (select id from public.staff where user_id = pg_temp.ctx('owner_a'))),
  ('co_staff', (select id from public.staff where user_id = pg_temp.ctx('co'))),
  ('co2_staff', (select id from public.staff where user_id = pg_temp.ctx('co2')));
select pg_temp.login(pg_temp.ctx('owner_a'));

-- The main owner can't be deactivated, removed, or demoted
select pg_temp.expect_fail($$update public.staff set active = false where id = pg_temp.ctx('main_staff')$$, 'main owner deactivated');
select pg_temp.expect_fail($$update public.staff set role = 'staff' where id = pg_temp.ctx('main_staff')$$, 'main owner demoted');
select pg_temp.expect_fail($$select public.remove_personnel(pg_temp.ctx('main_staff'), '9001')$$, 'main owner removed');

-- Staff: deactivate/reactivate directly
update public.staff set active = false where id = pg_temp.ctx('staff_a');
update public.staff set active = true where id = pg_temp.ctx('staff_a');
select pg_temp.check((select active from public.staff where id = pg_temp.ctx('staff_a')), 'staff reactivated');

-- Co-owners can't deactivate each other; the main owner can
select pg_temp.login(pg_temp.ctx('co'));
select pg_temp.expect_fail($$update public.staff set active = false where id = pg_temp.ctx('co2_staff')$$, 'co-owner deactivated a co-owner');
select pg_temp.login(pg_temp.ctx('owner_a'));
update public.staff set active = false where id = pg_temp.ctx('co_staff');

-- A deactivated co-owner loses access and can't sign in (without counting a wrong PIN)
select pg_temp.login(pg_temp.ctx('co'));
select pg_temp.check(not public.is_owner(pg_temp.ctx('biz_a')), 'deactivated co-owner has no access');
select pg_temp.check((select count(*) from public.products) = 0, 'deactivated co-owner reads nothing');
select pg_temp.as_service();
select pg_temp.check(public.co_owner_pin_login('co@test.com', '4321')->>'error' like '%turned off%', 'deactivated co-owner refused');
select pg_temp.check((select pin_failures from public.memberships where user_id = pg_temp.ctx('co')) = 0, 'not counted as a wrong PIN');

-- Reset PIN doesn't reactivate; reactivating restores access
select pg_temp.login(pg_temp.ctx('owner_a'));
select public.reset_co_owner_pin(pg_temp.ctx('co'), '4321');
select pg_temp.check(not (select active from public.staff where id = pg_temp.ctx('co_staff')), 'reset PIN kept them inactive');
update public.staff set active = true where id = pg_temp.ctx('co_staff');
select pg_temp.login(pg_temp.ctx('co'));
select pg_temp.check(public.is_owner(pg_temp.ctx('biz_a')), 'reactivated co-owner has access');

-- Remove needs the signed-in owner's own PIN
select pg_temp.expect_fail($$select public.remove_personnel(pg_temp.ctx('staff_a'), '9001')$$, 'co-owner removed staff with the main owner''s PIN');
select pg_temp.expect_fail($$select public.remove_personnel(pg_temp.ctx('co2_staff'), '4321')$$, 'co-owner removed a co-owner');
select public.remove_personnel(pg_temp.ctx('staff_a'), '4321');
select pg_temp.check((select removed_at is not null and not active from public.staff where id = pg_temp.ctx('staff_a')), 'staff removed');
select pg_temp.expect_fail($$update public.staff set active = true where id = pg_temp.ctx('staff_a')$$, 'removed staff reactivated');
select pg_temp.expect_fail($$select public.remove_personnel(pg_temp.ctx('staff_a'), '4321')$$, 'removed twice');

select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.expect_fail($$select public.remove_personnel(pg_temp.ctx('co2_staff'), '0000')$$, 'removed with a wrong PIN');
select public.remove_personnel(pg_temp.ctx('co2_staff'), '9001');
select pg_temp.check(not exists (select 1 from public.memberships where user_id = pg_temp.ctx('co2')), 'co-owner membership removed');
select pg_temp.login(pg_temp.ctx('co2'));
select pg_temp.check(not public.is_owner(pg_temp.ctx('biz_a')), 'removed co-owner has no access');

-- Other businesses can't remove
select pg_temp.login(pg_temp.ctx('owner_b'));
select pg_temp.expect_fail($$select public.remove_personnel(pg_temp.ctx('co_staff'), '9002')$$, 'other business removed a co-owner');

rollback;
