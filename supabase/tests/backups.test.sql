begin;
\ir _setup.sql

-- Runs are written by the Edge Function (service role); owners read their own.
insert into public.backup_runs (business_id, backup_date, status, finished_at, row_counts)
values (pg_temp.ctx('biz_a'), current_date - 3, 'success', now() - interval '3 days', '{"orders": 4}'),
       (pg_temp.ctx('biz_b'), current_date, 'success', now(), '{"orders": 1}');

select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check((public.backup_status()->>'stale')::boolean, 'no success in 48h: warning');
select pg_temp.check(jsonb_array_length(public.backup_status()->'recent') = 1, 'only own runs');
select pg_temp.check((public.backup_status()->>'retention_days')::int = 365, 'default retention');
select pg_temp.logout();
insert into public.backup_runs (business_id, backup_date, status, finished_at) values (pg_temp.ctx('biz_a'), current_date, 'success', now());
select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check(not (public.backup_status()->>'stale')::boolean, 'recent success: no warning');

-- Owner PIN for reports/exports: correct PIN is audited; a staff PIN is refused.
select pg_temp.check(public.check_owner_pin('9001', 'export')->>'name' = 'Owner A', 'owner PIN ok');
select pg_temp.check((select count(*) from public.audit_log where action = 'export') = 1, 'export audited');
do $$ begin
  begin
    perform public.check_owner_pin('1111');
    raise exception 'ASSERTION FAILED: staff PIN accepted';
  exception when raise_exception then if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

-- The tablet can't read backups or check owner PINs this way.
select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.check((select count(*) from public.backup_runs) = 0, 'device sees no runs');
do $$ begin
  begin
    perform public.backup_status();
    raise exception 'ASSERTION FAILED: device read backup status';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;
