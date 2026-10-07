begin;
\ir _setup.sql

select pg_temp.login(pg_temp.ctx('device_a'));
-- 10:15 and 11:40 Manila on Oct 10; one sale on Oct 11 at 09:05
select public.record_sale(pg_temp.sample_sale('d0000000-0000-4000-8000-000000000001', 1, '2026-10-10 10:15+08'));
select public.record_sale(pg_temp.sample_sale('d0000000-0000-4000-8000-000000000002', 3, '2026-10-10 11:40+08'));
select public.record_sale(pg_temp.sample_sale('d0000000-0000-4000-8000-000000000003', 1, '2026-10-11 09:05+08'));

select pg_temp.login(pg_temp.ctx('owner_a'));
do $$
declare r jsonb;
begin
  -- Oct 10 only (Manila day boundaries)
  r := public.dashboard_report('2026-10-10 00:00+08', '2026-10-11 00:00+08', null);
  perform pg_temp.check((r->'kpis'->>'transactions')::int = 2, 'two sales on Oct 10');
  perform pg_temp.check((r->'kpis'->>'revenue_centavos')::bigint = 74500 + 93500, 'Oct 10 revenue');
  perform pg_temp.check((r->'kpis'->>'bundle_revenue_centavos')::bigint = 130000, 'bundle revenue');
  perform pg_temp.check((r->'kpis'->>'transactions_with_bundle')::int = 2, 'attach');
  perform pg_temp.check((select (h->>'hour')::int from jsonb_array_elements(r->'by_hour') h order by (h->>'hour')::int limit 1) = 10, 'hour bucket in Manila');
  perform pg_temp.check(
    (select sum((p->>'revenue_centavos')::bigint) from jsonb_array_elements(r->'by_product') p) = (r->'kpis'->>'revenue_centavos')::bigint,
    'product revenue sums to revenue');
  perform pg_temp.check((r->'bundles'->0->>'separate_value_centavos')::bigint = 2 * 72000, 'separate value of 2 ube boxes');
  perform pg_temp.check(jsonb_array_length(r->'sell_through') = 7, 'sell-through rows for the event');

  -- Event scope ignores dates
  r := public.dashboard_report(null, null, pg_temp.ctx('event_a'));
  perform pg_temp.check((r->'kpis'->>'transactions')::int = 3, 'event scope');
  perform pg_temp.check(jsonb_array_length(r->'by_day_hour') = 3, 'three day-hour cells');
  perform pg_temp.check((select (s->>'sold')::int from jsonb_array_elements(r->'sell_through') s where s->>'product' = 'Ube Croissant') = 18, 'ube sold');
end $$;

-- Other owners and the device can't read it
select pg_temp.login(pg_temp.ctx('device_a'));
do $$ begin
  begin
    perform public.dashboard_report(null, null, null);
    raise exception 'ASSERTION FAILED: device read dashboard';
  exception when insufficient_privilege then null;
  end;
end $$;
select pg_temp.login(pg_temp.ctx('owner_b'));
select pg_temp.check((public.dashboard_report(null, null, null)->'kpis'->>'transactions')::int = 0, 'owner B sees nothing of A');

rollback;
