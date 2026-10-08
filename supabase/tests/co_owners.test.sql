begin;
\ir _setup.sql
grant select on ctx to service_role;

-- ---------------------------------------------------------------------------
-- Co-owners: the main owner adds them; they sign in with email + PIN.
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
  insert into auth.users (id, email) values (v_co, 'Co.Owner@test.com'), (v_co2, 'co2@test.com');
  insert into ctx values ('co', v_co), ('co2', v_co2);
end $$;

select pg_temp.as_service();
select pg_temp.check(public.login_kind('A@TEST')->>'kind' = 'owner', 'main owner asks for password');
select pg_temp.check(public.login_kind('co.owner@test.com')->>'kind' = 'unknown', 'not yet a co-owner');
select pg_temp.check(not (public.login_kind('x@test')->>'setup_open')::boolean, 'sign-up closed once a business exists');

-- Only the main owner can add co-owners
select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.expect_fail($$select public.add_co_owner('co.owner@test.com', 'Co', '4321')$$, 'device added a co-owner');
select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.expect_fail($$select public.add_co_owner('nobody@test.com', 'Co', '4321')$$, 'added an email with no login');
select pg_temp.expect_fail($$select public.add_co_owner('co.owner@test.com', 'Co', '9001')$$, 'duplicate PIN accepted');
select pg_temp.expect_fail($$select public.add_co_owner('b@test', 'B', '4321')$$, 'added an owner of another business');
select pg_temp.check(public.add_co_owner(' CO.OWNER@test.com ', 'Co Owner', '4321') = pg_temp.ctx('co'), 'co-owner added');
select pg_temp.expect_fail($$select public.add_co_owner('co.owner@test.com', 'Co', '4322')$$, 'added twice');
select pg_temp.check((select count(*) from public.business_owners(pg_temp.ctx('biz_a'))) = 2, 'two owners listed');
select pg_temp.check((select count(*) from public.business_owners(pg_temp.ctx('biz_a')) where co_owner) = 1, 'one co-owner');

-- A co-owner sees the business's data but can't manage owners
select pg_temp.login(pg_temp.ctx('co'));
select pg_temp.check(public.is_owner(pg_temp.ctx('biz_a')), 'co-owner is an owner');
select pg_temp.check(not public.is_main_owner(pg_temp.ctx('biz_a')), 'co-owner is not the main owner');
select pg_temp.check((select count(*) from public.products) > 0, 'co-owner reads products');
select pg_temp.expect_fail($$select public.add_co_owner('co2@test.com', 'Co2', '4322')$$, 'co-owner added a co-owner');
select pg_temp.expect_fail($$select public.reset_co_owner_pin(pg_temp.ctx('co'), '5555')$$, 'co-owner reset a PIN');
select pg_temp.expect_fail($$select public.remove_personnel((select id from public.staff where user_id = pg_temp.ctx('co')), '4321')$$, 'co-owner removed a co-owner');
delete from public.memberships where user_id in (pg_temp.ctx('owner_a'), pg_temp.ctx('device_a'));
select pg_temp.check((select count(*) from public.memberships where business_id = pg_temp.ctx('biz_a')) = 3, 'co-owner cannot delete memberships');

-- Owner B can't touch A's co-owner
select pg_temp.login(pg_temp.ctx('owner_b'));
select pg_temp.expect_fail($$select public.reset_co_owner_pin(pg_temp.ctx('co'), '5555')$$, 'other business reset a PIN');
select pg_temp.expect_fail($$select public.business_owners(pg_temp.ctx('biz_a'))$$, 'other business listed owners');

-- Sign-in: only the server (service role) can check PINs
select pg_temp.login(null);
select pg_temp.expect_fail($$select public.co_owner_pin_login('co.owner@test.com', '4321')$$, 'anon checked a PIN');
select pg_temp.login(pg_temp.ctx('co'));
select pg_temp.expect_fail($$select public.login_kind('co.owner@test.com')$$, 'authenticated called login_kind');

select pg_temp.as_service();
select pg_temp.check(public.login_kind('co.owner@test.com')->>'kind' = 'co_owner', 'co-owner asks for PIN');
select pg_temp.check((public.co_owner_pin_login('co.owner@test.com', '4321')->>'user_id')::uuid = pg_temp.ctx('co'), 'right PIN signs in');
select pg_temp.check(not (public.co_owner_pin_login('a@test', '9001')->>'ok')::boolean, 'main owner cannot use PIN sign-in');
select pg_temp.check((select count(*) from public.pin_uses where action = 'co_owner_login') = 1, 'sign-in logged');

-- 5 wrong → 15 min lock
select public.co_owner_pin_login('co.owner@test.com', '0000') from generate_series(1, 4);
select pg_temp.check(public.co_owner_pin_login('co.owner@test.com', '0000')->>'error' like '%15 minutes%', 'locked for 15 minutes');
select pg_temp.check(not (public.co_owner_pin_login('co.owner@test.com', '4321')->>'ok')::boolean, 'right PIN refused while locked');
-- Lock runs out; 5 more wrong → locked until reset
update public.memberships set pin_locked_until = now() - interval '1 second' where user_id = pg_temp.ctx('co');
select public.co_owner_pin_login('co.owner@test.com', '0000') from generate_series(1, 4);
select pg_temp.check(public.co_owner_pin_login('co.owner@test.com', '0000')->>'error' like '%until the owner resets%', 'locked until reset');
select pg_temp.check((select pin_locked_until from public.memberships where user_id = pg_temp.ctx('co')) = 'infinity', 'permanent lock');

-- Main owner resets the PIN, which unlocks
select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.expect_fail($$select public.reset_co_owner_pin(pg_temp.ctx('co'), '9001')$$, 'reset to a taken PIN');
select public.reset_co_owner_pin(pg_temp.ctx('co'), '5555');
select pg_temp.as_service();
select pg_temp.check(not (public.co_owner_pin_login('co.owner@test.com', '4321')->>'ok')::boolean, 'old PIN no longer works');
select pg_temp.check((public.co_owner_pin_login('co.owner@test.com', '5555')->>'ok')::boolean, 'new PIN works after reset');

-- Removing a co-owner ends their access and keeps their staff row inactive
select pg_temp.login(pg_temp.ctx('owner_a'));
select public.remove_personnel((select id from public.staff where user_id = pg_temp.ctx('co')), '9001');
select pg_temp.check((select active from public.staff where user_id = pg_temp.ctx('co')) = false, 'staff row kept inactive');
select pg_temp.login(pg_temp.ctx('co'));
select pg_temp.check(not public.is_owner(pg_temp.ctx('biz_a')), 'removed co-owner has no access');
select pg_temp.as_service();
select pg_temp.check(public.login_kind('co.owner@test.com')->>'kind' = 'unknown', 'removed co-owner is unknown');

rollback;
