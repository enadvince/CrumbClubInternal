begin;
\ir _setup.sql

-- A second tablet for the same business, and a third business's tablet.
do $$
declare v_dev2 uuid := gen_random_uuid(); v_dev_b uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_dev2, 'dev2@test'), (v_dev_b, 'devb@test');
  insert into public.memberships (user_id, business_id, role, label) values
    (v_dev2, pg_temp.ctx('biz_a'), 'device', 'Back counter'),
    (v_dev_b, pg_temp.ctx('biz_b'), 'device', null);
  insert into ctx values ('device_a2', v_dev2), ('device_b', v_dev_b);
end $$;

-- 1. Claiming codes: T1, then T2 for the next tablet; claiming again is idempotent; codes are per business.
select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.check(public.claim_device_code('Front')->>'device_code' = 'T1', 'first tablet is T1');
select pg_temp.check(public.claim_device_code()->>'device_code' = 'T1', 'claim is idempotent');
select pg_temp.login(pg_temp.ctx('device_a2'));
select pg_temp.check(public.claim_device_code()->>'device_code' = 'T2', 'second tablet is T2');
select pg_temp.logout();
insert into ctx select 'dev_t1', id from public.pos_devices where device_user_id = pg_temp.ctx('device_a');
insert into ctx select 'dev_t2', id from public.pos_devices where device_user_id = pg_temp.ctx('device_a2');
select pg_temp.login(pg_temp.ctx('device_b'));
select pg_temp.check(public.claim_device_code()->>'device_code' = 'T1', 'codes are per business');
select pg_temp.login(pg_temp.ctx('owner_a'));
do $$ begin
  begin
    perform public.claim_device_code();
    raise exception 'ASSERTION FAILED: owner claimed a device code';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 2. A sale with its order number and device id is stored with both.
select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.check(public.record_sale(
  pg_temp.sample_sale('c0000000-0000-4000-8000-000000000001') ||
  jsonb_build_object('order_number', 'T1-261008-0001', 'device_id', pg_temp.ctx('dev_t1'), 'device_sent_at', now())
)->>'order_number' = 'T1-261008-0001', 'order number kept');
select pg_temp.check((select device_id from public.transactions where id = 'c0000000-0000-4000-8000-000000000001') = pg_temp.ctx('dev_t1'), 'device id stored');
select pg_temp.check((select client_order_id from public.transactions where id = 'c0000000-0000-4000-8000-000000000001') = 'c0000000-0000-4000-8000-000000000001', 'client_order_id = id');

-- 3. Re-sending the same order never duplicates it.
select pg_temp.check(public.record_sale(
  pg_temp.sample_sale('c0000000-0000-4000-8000-000000000001') ||
  jsonb_build_object('order_number', 'T1-261008-0001', 'device_id', pg_temp.ctx('dev_t1'))
)->>'status' = 'duplicate', 'resend is a duplicate');
select pg_temp.check((select count(*) from public.transactions where order_number = 'T1-261008-0001') = 1, 'one row');

-- 4. A tablet can't record an order as another tablet, or with another tablet's code.
do $$ begin
  begin
    perform public.record_sale(pg_temp.sample_sale('c0000000-0000-4000-8000-000000000002') ||
      jsonb_build_object('order_number', 'T2-261008-0001', 'device_id', pg_temp.ctx('dev_t2')));
    raise exception 'ASSERTION FAILED: wrote as another device';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_sale(pg_temp.sample_sale('c0000000-0000-4000-8000-000000000003') ||
      jsonb_build_object('order_number', 'T2-261008-0001', 'device_id', pg_temp.ctx('dev_t1')));
    raise exception 'ASSERTION FAILED: accepted another tablet''s code';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

-- 5. A clashing number never loses the sale: it is renamed and flagged.
select pg_temp.check(public.record_sale(
  pg_temp.sample_sale('c0000000-0000-4000-8000-000000000004') ||
  jsonb_build_object('order_number', 'T1-261008-0001', 'device_id', pg_temp.ctx('dev_t1'))
)->>'status' = 'ok', 'clash recorded');
select pg_temp.check((select 'order_number_conflict' = any(flags) and order_number like 'T1-261008-0001-%'
  from public.transactions where id = 'c0000000-0000-4000-8000-000000000004'), 'clash flagged and renamed');

-- 6. Older app versions without an order number still sync, numbered from the tablet's code.
select pg_temp.check(public.record_sale(pg_temp.sample_sale('c0000000-0000-4000-8000-000000000005'))->>'order_number' like 'T1-______-%', 'legacy payload numbered');

-- 7. Clock drift: the server keeps its own created_at, stores the offset and flags it.
select public.record_sale(pg_temp.sample_sale('c0000000-0000-4000-8000-000000000006', 1, now() - interval '3 hours') ||
  jsonb_build_object('order_number', 'T1-261008-0009', 'device_id', pg_temp.ctx('dev_t1'), 'device_sent_at', now() - interval '3 hours'));
select pg_temp.check((select 'clock_drift' = any(flags) and abs(clock_offset_ms - 10800000) < 60000 and created_at = now()
  and created_at_device = client_created_at
  from public.transactions where id = 'c0000000-0000-4000-8000-000000000006'), 'drift detected, server time kept');

-- 8. The snapshot tells the tablet its code and the highest sequence used per day.
select pg_temp.check(public.pos_snapshot()->'device'->>'code' = 'T1', 'snapshot device code');
select pg_temp.check((public.pos_snapshot()->'device'->'order_counters'->>'261008')::int = 9, 'snapshot counters');

-- 9. Devices only see their own registration; owners see all of theirs.
select pg_temp.check((select count(*) from public.pos_devices) = 1, 'device sees itself only');
select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check((select count(*) from public.pos_devices) = 2, 'owner sees both tablets');
select pg_temp.check(public.pos_ping()->>'member' = 'true', 'ping works');

rollback;
