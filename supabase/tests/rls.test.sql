begin;
\ir _setup.sql

-- Owner A sees only business A
select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check((select count(*) from public.businesses) = 1, 'owner sees one business');
select pg_temp.check((select count(*) from public.products where business_id = pg_temp.ctx('biz_b')) = 0,
  'owner A cannot read business B products');
select pg_temp.check((select count(*) from public.products) = 7, 'owner A sees own 7 products');
select pg_temp.check((select count(*) from public.staff) = 3, 'owner sees own staff');

-- Owner A cannot write into business B
do $$ begin
  begin
    insert into public.products (business_id, name, default_price_centavos, cost_centavos)
    values (pg_temp.ctx('biz_b'), 'Hack', 100, 50);
    raise exception 'ASSERTION FAILED: cross-business insert allowed';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Owner cannot write trigger-maintained stock or PIN hashes directly
do $$ begin
  begin
    update public.event_products set current_stock = 999;
    raise exception 'ASSERTION FAILED: current_stock writable';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.staff set pin_hash = 'x';
    raise exception 'ASSERTION FAILED: pin_hash writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Device: reads the menu, cannot read staff, cannot write catalog, cannot void
select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.check((select count(*) from public.event_products) = 7, 'device reads menu');
select pg_temp.check((select count(*) from public.staff) = 0, 'device cannot read staff rows');
select pg_temp.check((public.pos_snapshot(null)->'event'->>'id')::uuid = pg_temp.ctx('event_a'), 'snapshot picks live event');
select pg_temp.check(jsonb_array_length(public.pos_snapshot(null)->'staff') = 3, 'snapshot includes staff PIN hashes');
do $$ begin
  begin
    update public.products set default_price_centavos = 1;
    -- RLS silently filters rows for update; make sure nothing changed
  exception when insufficient_privilege then null;
  end;
end $$;
select pg_temp.logout();
select pg_temp.check((select count(*) from public.products where default_price_centavos = 1) = 0, 'device cannot edit products');

select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.check(public.record_sale(pg_temp.sample_sale('11111111-1111-4111-8111-111111111111'))->>'status' = 'ok', 'device records sale');
do $$ begin
  begin
    perform public.void_sale('11111111-1111-4111-8111-111111111111', 'changed mind');
    raise exception 'ASSERTION FAILED: device voided with non-undo reason';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

-- Owner B can neither see nor void business A's sale
select pg_temp.login(pg_temp.ctx('owner_b'));
select pg_temp.check((select count(*) from public.transactions) = 0, 'owner B sees no A sales');
do $$ begin
  begin
    perform public.void_sale('11111111-1111-4111-8111-111111111111', 'x');
    raise exception 'ASSERTION FAILED: cross-business void';
  exception when insufficient_privilege then null;
  end;
end $$;
do $$ begin
  begin
    perform public.pos_snapshot(pg_temp.ctx('event_a'));
  end;
end $$;
select pg_temp.check((public.pos_snapshot(pg_temp.ctx('event_a'))->'event') = 'null'::jsonb, 'owner B cannot snapshot A event');

-- Anonymous: nothing
select pg_temp.login(null);
do $$ begin
  begin
    perform count(*) from public.products;
    raise exception 'ASSERTION FAILED: anon read products';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_sale('{}'::jsonb);
    raise exception 'ASSERTION FAILED: anon called record_sale';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
