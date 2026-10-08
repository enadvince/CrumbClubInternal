begin;
\ir _setup.sql

-- ---------------------------------------------------------------------------
-- Owner invites: an owner invites by email; the invitee accepts with that email.
-- ---------------------------------------------------------------------------
create temp table tok (k text primary key, v text);
grant all on tok to authenticated, anon;

do $$
declare v_new uuid := gen_random_uuid(); v_other uuid := gen_random_uuid(); v_member uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_new, 'New.Owner@test.com'), (v_other, 'other@test.com'), (v_member, 'member@test.com');
  insert into ctx values ('new_owner', v_new), ('other_user', v_other), ('member_b', v_member);
  insert into public.memberships (user_id, business_id, role) values (v_member, pg_temp.ctx('biz_b'), 'owner');
end $$;

-- Staff, devices and anon can't invite
select pg_temp.login(pg_temp.ctx('device_a'));
do $$ begin
  begin
    perform public.create_owner_invite('x@test.com');
    raise exception 'ASSERTION FAILED: device created an invite';
  exception when insufficient_privilege then null;
  end;
end $$;

select pg_temp.login(pg_temp.ctx('owner_a'));
do $$ begin
  begin
    perform public.create_owner_invite('not-an-email');
    raise exception 'ASSERTION FAILED: bad email accepted';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
  begin
    perform public.create_owner_invite('a@test');
    raise exception 'ASSERTION FAILED: invited an existing owner';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

insert into tok values ('first', (public.create_owner_invite('  New.Owner@Test.com ')->>'token'));
insert into tok values ('second', (public.create_owner_invite('new.owner@test.com')->>'token'));
select pg_temp.check((select count(*) from public.owner_invites) = 2, 'owner sees both invites');
select pg_temp.check((select count(*) from public.owner_invites where revoked_at is null) = 1, 're-inviting replaces the open invite');
select pg_temp.check((select email from public.owner_invites where revoked_at is null) = 'new.owner@test.com', 'email normalised');
do $$ begin
  begin
    perform token_hash from public.owner_invites;
    raise exception 'ASSERTION FAILED: token hash readable';
  exception when insufficient_privilege then null;
  end;
end $$;

select pg_temp.login(pg_temp.ctx('owner_b'));
select pg_temp.check((select count(*) from public.owner_invites) = 0, 'owner B cannot see A''s invites');

-- Anyone holding the link can look the invite up
select pg_temp.login(null);
select pg_temp.check(public.get_owner_invite((select v from tok where k = 'second'))->>'status' = 'pending', 'pending invite');
select pg_temp.check(public.get_owner_invite((select v from tok where k = 'second'))->>'business_name' = 'Biz A', 'business name');
select pg_temp.check((public.get_owner_invite((select v from tok where k = 'second'))->>'account_exists')::boolean, 'account exists');
select pg_temp.check(public.get_owner_invite((select v from tok where k = 'first'))->>'status' = 'revoked', 'replaced invite is revoked');
select pg_temp.check(public.get_owner_invite('nope') is null, 'unknown token');
do $$ begin
  begin
    perform public.accept_owner_invite((select v from tok where k = 'second'), 'New', '4321');
    raise exception 'ASSERTION FAILED: anon accepted';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Wrong email, revoked token, already in a business, taken PIN
select pg_temp.login(pg_temp.ctx('other_user'));
do $$ begin
  begin
    perform public.accept_owner_invite((select v from tok where k = 'second'), 'Other', '4321');
    raise exception 'ASSERTION FAILED: wrong email accepted';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select pg_temp.login(pg_temp.ctx('new_owner'));
do $$ begin
  begin
    perform public.accept_owner_invite((select v from tok where k = 'first'), 'New', '4321');
    raise exception 'ASSERTION FAILED: revoked invite accepted';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
  begin
    perform public.accept_owner_invite((select v from tok where k = 'second'), 'New', '9001');
    raise exception 'ASSERTION FAILED: duplicate PIN accepted';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

select pg_temp.check(public.accept_owner_invite((select v from tok where k = 'second'), ' New Owner ', '4321') = pg_temp.ctx('biz_a'), 'accepted');
select pg_temp.check(public.is_owner(pg_temp.ctx('biz_a')), 'invitee is now an owner');
select pg_temp.check((select count(*) from public.products) > 0, 'invitee reads the business''s data');
do $$ begin
  begin
    perform public.accept_owner_invite((select v from tok where k = 'second'), 'Again', '4322');
    raise exception 'ASSERTION FAILED: invite reused';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

select pg_temp.login(pg_temp.ctx('owner_a'));
select pg_temp.check((select count(*) from public.staff where name = 'New Owner' and role = 'owner' and pin_hash is not null) = 1, 'owner staff row with PIN');
select pg_temp.check((select count(*) from public.business_owners(pg_temp.ctx('biz_a'))) = 2, 'two owners listed');
select pg_temp.check(public.get_owner_invite((select v from tok where k = 'second'))->>'status' = 'accepted', 'invite marked accepted');
do $$ begin
  begin
    perform public.create_owner_invite('new.owner@test.com');
    raise exception 'ASSERTION FAILED: re-invited an owner';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
  begin
    perform public.business_owners(pg_temp.ctx('biz_b'));
    raise exception 'ASSERTION FAILED: listed another business''s owners';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Revoke and expiry
insert into tok values ('third', (public.create_owner_invite('third@test.com')->>'token'));
select public.revoke_owner_invite((select id from public.owner_invites where email = 'third@test.com'));
select pg_temp.check(public.get_owner_invite((select v from tok where k = 'third'))->>'status' = 'revoked', 'revoked');
insert into tok values ('fourth', (public.create_owner_invite('member@test.com')->>'token'));
insert into tok values ('fourth_id', (select id::text from public.owner_invites where email = 'member@test.com'));
select pg_temp.login(pg_temp.ctx('owner_b'));
do $$ begin
  begin
    perform public.revoke_owner_invite((select v::uuid from tok where k = 'fourth_id'));
    raise exception 'ASSERTION FAILED: owner B revoked A''s invite';
  exception when insufficient_privilege then null;
  end;
end $$;
select pg_temp.login(pg_temp.ctx('member_b'));
do $$ begin
  begin
    perform public.accept_owner_invite((select v from tok where k = 'fourth'), 'Member', '4323');
    raise exception 'ASSERTION FAILED: member of another business accepted';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;
select pg_temp.logout();
update public.owner_invites set expires_at = now() - interval '1 minute' where email = 'member@test.com';
select pg_temp.check(public.get_owner_invite((select v from tok where k = 'fourth'))->>'status' = 'expired', 'expired');

rollback;
