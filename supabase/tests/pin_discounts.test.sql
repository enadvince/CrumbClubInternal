begin;
\ir _setup.sql

-- ---------------------------------------------------------------------------
-- PIN log: the tablet adds rows; owners read them; nobody edits them.
-- ---------------------------------------------------------------------------
select pg_temp.login(pg_temp.ctx('device_a'));
select public.log_pin_use(jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000001',
  'staff_id', pg_temp.ctx('staff_a'), 'action', 'sign_in', 'used_at', now()));
-- Retrying the same entry is a no-op
select public.log_pin_use(jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000001',
  'staff_id', pg_temp.ctx('staff_a'), 'action', 'sign_in', 'used_at', now()));
select pg_temp.check((select count(*) from public.pin_uses) = 0, 'device cannot read the PIN log');

-- Another business's staff is rejected
do $$ begin
  begin
    perform public.log_pin_use(jsonb_build_object('id', gen_random_uuid(),
      'staff_id', (select id from public.staff where business_id = pg_temp.ctx('biz_b') limit 1), 'action', 'sign_in', 'used_at', now()));
    raise exception 'ASSERTION FAILED: other business staff logged';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check((select count(*) from public.pin_uses) = 1, 'owner sees one PIN use');
select pg_temp.check((select staff_name from public.pin_uses) = 'Staff One', 'name snapshot');
select pg_temp.check((select device_user_id from public.pin_uses) = pg_temp.ctx('device_a'), 'device recorded');
do $$ begin
  begin
    update public.pin_uses set action = 'owner_menu';
    raise exception 'ASSERTION FAILED: PIN log editable';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.pin_uses;
    raise exception 'ASSERTION FAILED: PIN log deletable';
  exception when insufficient_privilege then null;
  end;
end $$;

select pg_temp.login(pg_temp.ctx('owner_b'));
select pg_temp.check((select count(*) from public.pin_uses) = 0, 'owner B cannot read A''s PIN log');

-- ---------------------------------------------------------------------------
-- Discount options: owners manage, the tablet gets active ones in the snapshot.
-- ---------------------------------------------------------------------------
select pg_temp.login(pg_temp.ctx('owner_a'));
insert into public.discount_options (business_id, name, type, value) values
  (pg_temp.ctx('biz_a'), 'Senior citizen', 'percent', 2000),
  (pg_temp.ctx('biz_a'), 'Old promo', 'fixed', 5000);
update public.discount_options set active = false where name = 'Old promo';
do $$ begin
  begin
    insert into public.discount_options (business_id, name, type, value) values (pg_temp.ctx('biz_a'), 'Too much', 'percent', 20000);
    raise exception 'ASSERTION FAILED: >100%% accepted';
  exception when check_violation then null;
  end;
end $$;

select pg_temp.login(pg_temp.ctx('device_a'));
select pg_temp.check(jsonb_array_length(public.pos_snapshot()->'discount_options') = 1, 'snapshot has active options only');
select pg_temp.check(public.pos_snapshot()->'discount_options'->0->>'name' = 'Senior citizen', 'snapshot option name');
do $$ begin
  begin
    insert into public.discount_options (business_id, name, type, value) values (pg_temp.ctx('biz_a'), 'Hack', 'fixed', 1);
    raise exception 'ASSERTION FAILED: device created a discount option';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Owner void needs an owner PIN, and is logged.
-- ---------------------------------------------------------------------------
select public.record_sale(pg_temp.sample_sale('a0000000-0000-4000-8000-000000000011'));
select pg_temp.login(pg_temp.ctx('owner_a'));
do $$ begin
  begin
    perform public.void_sale_with_owner_pin('a0000000-0000-4000-8000-000000000011', 'wrong item', '0000');
    raise exception 'ASSERTION FAILED: wrong PIN accepted';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select pg_temp.check((select status from public.transactions where id = 'a0000000-0000-4000-8000-000000000011') = 'completed', 'not voided on wrong PIN');
select pg_temp.check(public.void_sale_with_owner_pin('a0000000-0000-4000-8000-000000000011', 'wrong item', '9001')->>'status' = 'ok', 'void with owner PIN');
select pg_temp.check((select voided_by_staff_id from public.transactions where id = 'a0000000-0000-4000-8000-000000000011')
  = (select id from public.staff where user_id = pg_temp.ctx('owner_a')), 'voided by the PIN''s owner');
select pg_temp.check((select count(*) from public.pin_uses where action = 'void_approval') = 1, 'void approval logged');

-- Owner B can't void A's sale even with A's PIN
select pg_temp.login(pg_temp.ctx('owner_b'));
do $$ begin
  begin
    perform public.void_sale_with_owner_pin('a0000000-0000-4000-8000-000000000011', 'x', '9001');
    raise exception 'ASSERTION FAILED: cross-business void';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
