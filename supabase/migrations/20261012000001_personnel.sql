-- Personnel: owners (main + co-owners) and staff are managed on one page.
--
-- * Deactivate / reactivate: anyone except the main owner. Co-owners can only be
--   deactivated or reactivated by the main owner. A deactivated co-owner keeps
--   their login but loses owner access until reactivated.
-- * Remove: needs the signed-in owner's own PIN (remove_personnel()). The main
--   owner can't be removed; only the main owner can remove co-owners. The staff
--   row is kept (inactive, removed_at set) so past sales keep the name.

alter table public.staff add column removed_at timestamptz;

-- A co-owner whose staff row is inactive is not an owner (or member) right now.
create or replace function public.is_member(p_business uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid() and m.business_id = p_business
      and (not m.co_owner or exists (
        select 1 from public.staff s where s.business_id = m.business_id and s.user_id = m.user_id and s.active))
  );
$$;

create or replace function public.is_owner(p_business uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid() and m.business_id = p_business and m.role = 'owner'
      and (not m.co_owner or exists (
        select 1 from public.staff s where s.business_id = m.business_id and s.user_id = m.user_id and s.active))
  );
$$;

-- Guards direct updates to staff rows (owners may update name, role, active).
create or replace function public._tg_staff_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_member public.memberships;
begin
  if old.removed_at is not null and new.active then
    perform public._fail('This person was removed and can''t be reactivated');
  end if;
  if new.user_id is null or auth.uid() is null then return new; end if;
  select * into v_member from public.memberships
   where user_id = new.user_id and business_id = new.business_id and role = 'owner';
  if v_member.user_id is null then return new; end if;

  if new.role is distinct from old.role then perform public._fail('An owner''s role can''t be changed'); end if;
  if new.active is distinct from old.active then
    if not v_member.co_owner then perform public._fail('The main owner can''t be deactivated'); end if;
    perform public._require_main_owner(new.business_id);
  end if;
  return new;
end $$;

create trigger staff_guard before update on public.staff
  for each row execute function public._tg_staff_guard();

-- Resetting a co-owner's PIN no longer reactivates them.
create or replace function public.reset_co_owner_pin(p_user uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_member public.memberships; v_staff uuid;
begin
  select * into v_member from public.memberships where user_id = p_user and co_owner;
  if v_member.user_id is null then perform public._fail('co-owner not found'); end if;
  perform public._require_main_owner(v_member.business_id);
  select id into v_staff from public.staff
   where business_id = v_member.business_id and user_id = p_user order by created_at limit 1;
  perform public._check_pin(v_member.business_id, p_pin, v_staff);
  update public.staff set pin_hash = public._hash_pin(p_pin) where id = v_staff;
  update public.memberships set pin_failures = 0, pin_lockouts = 0, pin_locked_until = null
   where user_id = p_user and business_id = v_member.business_id;
end $$;

-- Removing anyone (staff or co-owner) now needs the owner's PIN.
drop function public.remove_co_owner(uuid);

create or replace function public.remove_personnel(p_staff_id uuid, p_owner_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_staff public.staff;
  v_me public.staff;
  v_member public.memberships;
begin
  select * into v_staff from public.staff where id = p_staff_id and removed_at is null;
  if v_staff.id is null then perform public._fail('Person not found'); end if;
  perform public._require_owner(v_staff.business_id);

  select * into v_me from public.staff
   where business_id = v_staff.business_id and user_id = auth.uid() and active
   order by created_at limit 1;
  if v_me.pin_hash is null or coalesce(p_owner_pin, '') !~ '^[0-9]{4}$'
     or extensions.crypt(p_owner_pin, v_me.pin_hash) <> v_me.pin_hash then
    perform public._fail('Wrong owner PIN. Nobody was removed.');
  end if;

  if v_staff.user_id is not null then
    select * into v_member from public.memberships
     where user_id = v_staff.user_id and business_id = v_staff.business_id and role = 'owner';
    if v_member.user_id is not null then
      if not v_member.co_owner then perform public._fail('The main owner can''t be removed'); end if;
      perform public._require_main_owner(v_staff.business_id);
      delete from public.memberships where user_id = v_member.user_id and business_id = v_member.business_id;
    end if;
  end if;

  update public.staff set active = false, removed_at = now() where id = p_staff_id;
end $$;

-- Same as before, except a deactivated co-owner is told so (and it isn't a wrong PIN).
create or replace function public.co_owner_pin_login(p_email text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_member public.memberships;
  v_staff public.staff;
  v_ok boolean;
  v_failures int;
  v_lockouts int;
  v_until timestamptz;
begin
  select m.* into v_member
    from auth.users u join public.memberships m on m.user_id = u.id
   where lower(u.email) = lower(trim(coalesce(p_email, ''))) and m.role = 'owner' and m.co_owner
   for update of m;
  if v_member.user_id is null then
    return jsonb_build_object('ok', false, 'error', 'That email isn''t a co-owner.');
  end if;

  if v_member.pin_locked_until is not null and v_member.pin_locked_until > now() then
    return jsonb_build_object('ok', false, 'locked_until', v_member.pin_locked_until,
      'error', case when v_member.pin_locked_until = 'infinity'
        then 'Too many wrong PINs. Ask the owner to reset your PIN.'
        else 'Too many wrong PINs. Try again later.' end);
  end if;

  select * into v_staff from public.staff
   where business_id = v_member.business_id and user_id = v_member.user_id and active
   order by created_at limit 1;
  if v_staff.id is null then
    return jsonb_build_object('ok', false, 'error', 'Your access is turned off. Ask the owner to reactivate you.');
  end if;
  v_ok := v_staff.pin_hash is not null and coalesce(p_pin, '') ~ '^[0-9]{4}$'
          and extensions.crypt(p_pin, v_staff.pin_hash) = v_staff.pin_hash;

  if v_ok then
    update public.memberships set pin_failures = 0, pin_lockouts = 0, pin_locked_until = null
     where user_id = v_member.user_id and business_id = v_member.business_id;
    insert into public.pin_uses (id, business_id, staff_id, staff_name, staff_role, action, used_at)
      values (gen_random_uuid(), v_member.business_id, v_staff.id, v_staff.name, v_staff.role, 'co_owner_login', now());
    return jsonb_build_object('ok', true, 'user_id', v_member.user_id);
  end if;

  v_failures := v_member.pin_failures + 1;
  v_lockouts := v_member.pin_lockouts;
  v_until := null;
  if v_failures >= 5 then
    v_lockouts := v_lockouts + 1;
    v_failures := 0;
    v_until := case when v_lockouts >= 2 then 'infinity'::timestamptz else now() + interval '15 minutes' end;
  end if;
  update public.memberships set pin_failures = v_failures, pin_lockouts = v_lockouts, pin_locked_until = v_until
   where user_id = v_member.user_id and business_id = v_member.business_id;

  return jsonb_build_object('ok', false, 'locked_until', v_until, 'error', case
    when v_until = 'infinity' then 'Too many wrong PINs. Your login is locked until the owner resets your PIN.'
    when v_until is not null then 'Too many wrong PINs. Try again in 15 minutes.'
    else 'Wrong PIN. ' || (5 - v_failures) || ' tries left.' end);
end $$;

revoke all on function public._tg_staff_guard(), public.remove_personnel(uuid, text) from public, anon, authenticated;
grant execute on function public.remove_personnel(uuid, text) to authenticated;
