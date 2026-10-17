begin;
\ir _setup.sql

select pg_temp.login(pg_temp.ctx('device_a'));
select public.claim_device_code('Counter tablet');
select public.open_shift(jsonb_build_object('id', '5f000000-0000-4000-8000-0000000000a1', 'event_id', pg_temp.ctx('event_a'),
  'opened_at', now(), 'opened_by_staff_id', pg_temp.ctx('staff_a'), 'opening_float_centavos', 100000, 'opening_denoms', '{}'::jsonb));
select public.device_heartbeat(2, now(), 'test');
select pg_temp.logout();
insert into ctx values ('dev_a', (select id from public.pos_devices where device_user_id = pg_temp.ctx('device_a')));

-- 1. Closing the event closes its open shifts; the tablet can still count and close it later.
select pg_temp.login(pg_temp.ctx('owner_a'));
select public.close_event(pg_temp.ctx('event_a'), 100000, null);
select pg_temp.check((select status = 'closed' and close_note = 'Closed automatically when the event was closed' and counted_cash_centavos is null
  from public.shifts where id = '5f000000-0000-4000-8000-0000000000a1'), 'event close closes the shift');
select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.check(public.close_shift(jsonb_build_object('id', '5f000000-0000-4000-8000-0000000000a1', 'closed_at', now(),
  'closed_by_staff_id', pg_temp.ctx('staff_a'), 'counted_cash_centavos', 100000, 'expected_cash_centavos', 100000,
  'counted_denoms', '{}'::jsonb))->>'status' = 'ok', 'tablet can still close it with a count');

-- 2. Rename: owners only, and the name shows on the device membership too.
do $$ begin
  begin
    perform public.rename_device(pg_temp.ctx('dev_a'), 'Hacked');
    raise exception 'ASSERTION FAILED: tablet renamed itself';
  exception when insufficient_privilege then null;
  end;
end $$;
select pg_temp.login(pg_temp.ctx('owner_b'));
do $$ begin
  begin
    perform public.rename_device(pg_temp.ctx('dev_a'), 'Hacked');
    raise exception 'ASSERTION FAILED: other business renamed tablet';
  exception when insufficient_privilege then null;
  end;
end $$;
select pg_temp.login(pg_temp.ctx('owner_a'));
select public.rename_device(pg_temp.ctx('dev_a'), '  Front counter ');
select pg_temp.check((select label from public.pos_devices where id = pg_temp.ctx('dev_a')) = 'Front counter', 'renamed');
select pg_temp.check((select label from public.memberships where user_id = pg_temp.ctx('device_a')) = 'Front counter', 'membership renamed');
select pg_temp.check((select count(*) from public.device_heartbeats) = 1, 'owner sees heartbeat');

-- 3. Remove: the tablet loses access at once; its history stays.
select pg_temp.login(pg_temp.ctx('owner_b'));
do $$ begin
  begin
    perform public.remove_device(pg_temp.ctx('dev_a'));
    raise exception 'ASSERTION FAILED: other business removed tablet';
  exception when insufficient_privilege then null;
  end;
end $$;
select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check(public.remove_device(pg_temp.ctx('dev_a'))->>'device_user_id' = pg_temp.ctx('device_a')::text, 'remove returns login');
select pg_temp.check(public.remove_device(pg_temp.ctx('dev_a'))->>'device_code' = 'T1', 'remove is idempotent');
select pg_temp.check((select removed_at is not null from public.pos_devices where id = pg_temp.ctx('dev_a')), 'marked removed');
select pg_temp.check(not exists (select 1 from public.memberships where user_id = pg_temp.ctx('device_a')), 'membership gone');
select pg_temp.check((select count(*) from public.device_heartbeats) = 0, 'heartbeat gone');
select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.check(public.pos_ping()->>'member' = 'false', 'removed tablet is no longer a member');
do $$ begin
  begin
    perform public.claim_device_code();
    raise exception 'ASSERTION FAILED: removed tablet claimed a code';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
