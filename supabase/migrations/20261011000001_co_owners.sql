-- Co-owners. The business's main owner (who created it) signs in with email
-- and password. They add co-owners by email; a co-owner signs in with that
-- email and their 4-digit PIN (checked on the server, see co_owner_pin_login()).
-- Co-owners see everything an owner sees but can't add or remove owners.
--
-- PIN lockout for co-owner sign-in: 5 wrong PINs lock the login for 15 minutes;
-- 5 more wrong PINs after that lock it until the main owner resets the PIN.

alter table public.memberships
  add column co_owner boolean not null default false,
  add column pin_failures int not null default 0,
  add column pin_lockouts int not null default 0,
  add column pin_locked_until timestamptz;

alter table public.pin_uses drop constraint pin_uses_action_check;
alter table public.pin_uses add constraint pin_uses_action_check
  check (action in ('sign_in', 'owner_menu', 'owner_view', 'void_approval', 'co_owner_login'));

create or replace function public.is_main_owner(p_business uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and business_id = p_business and role = 'owner' and not co_owner
  );
$$;

create or replace function public._require_main_owner(p_business uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_main_owner(p_business) then
    raise exception 'only the main owner can manage owners' using errcode = '42501';
  end if;
end $$;

-- Only the main owner may remove memberships (devices and co-owners).
drop policy memberships_owner_delete on public.memberships;
create policy memberships_main_owner_delete on public.memberships
  for delete to authenticated using (public.is_main_owner(business_id) and user_id <> auth.uid());

-- ---------------------------------------------------------------------------
-- Managing co-owners (main owner only)
-- ---------------------------------------------------------------------------

-- The login for p_email must already exist (the server creates it first) and
-- must not belong to any business yet.
create or replace function public.add_co_owner(p_email text, p_name text, p_pin text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_business uuid;
  v_user uuid;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() and role = 'owner' order by created_at limit 1;
  if v_business is null then raise exception 'owner access required' using errcode = '42501'; end if;
  perform public._require_main_owner(v_business);
  if length(trim(coalesce(p_name, ''))) = 0 then perform public._fail('Enter their name'); end if;

  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then perform public._fail('No login exists for that email'); end if;
  if exists (select 1 from public.memberships where user_id = v_user and business_id = v_business) then
    perform public._fail('That person is already an owner');
  end if;
  if exists (select 1 from public.memberships where user_id = v_user) then
    perform public._fail('That email is already used by another business');
  end if;
  perform public._check_pin(v_business, p_pin, null);

  insert into public.memberships (user_id, business_id, role, co_owner) values (v_user, v_business, 'owner', true);
  insert into public.staff (business_id, name, role, user_id, pin_hash)
    values (v_business, trim(p_name), 'owner', v_user, public._hash_pin(p_pin));
  return v_user;
end $$;

-- Sets a new PIN and clears any lockout.
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
  update public.staff set pin_hash = public._hash_pin(p_pin), active = true where id = v_staff;
  update public.memberships set pin_failures = 0, pin_lockouts = 0, pin_locked_until = null
   where user_id = p_user and business_id = v_member.business_id;
end $$;

-- Removes access. Their staff row is kept (inactive) so past sales keep their name.
create or replace function public.remove_co_owner(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_member public.memberships;
begin
  select * into v_member from public.memberships where user_id = p_user and co_owner;
  if v_member.user_id is null then perform public._fail('co-owner not found'); end if;
  perform public._require_main_owner(v_member.business_id);
  delete from public.memberships where user_id = p_user and business_id = v_member.business_id;
  update public.staff set active = false where business_id = v_member.business_id and user_id = p_user;
end $$;

-- Owners of a business with their emails and lock state (for the Owners page).
create or replace function public.business_owners(p_business uuid)
returns table (user_id uuid, email text, name text, co_owner boolean, joined_at timestamptz,
               pin_locked_until timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_owner(p_business);
  return query
    select m.user_id, u.email::text,
      (select s.name from public.staff s where s.business_id = p_business and s.user_id = m.user_id
        order by s.created_at limit 1),
      m.co_owner, m.created_at, m.pin_locked_until
    from public.memberships m join auth.users u on u.id = m.user_id
    where m.business_id = p_business and m.role = 'owner'
    order by m.co_owner, m.created_at;
end $$;

-- ---------------------------------------------------------------------------
-- Sign-in (called only by the server with the service key)
-- ---------------------------------------------------------------------------

-- What the login page should ask for after the email: 'owner' (password),
-- 'co_owner' (PIN), or 'unknown'. setup_open is true while no business exists,
-- so the very first owner can create an account.
create or replace function public.login_kind(p_email text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'kind', coalesce((
      select case when m.co_owner then 'co_owner' else 'owner' end
      from auth.users u join public.memberships m on m.user_id = u.id and m.role = 'owner'
      where lower(u.email) = lower(trim(coalesce(p_email, '')))
      order by m.created_at limit 1), 'unknown'),
    'setup_open', not exists (select 1 from public.businesses)
  );
$$;

-- Checks a co-owner's PIN, applies the lockout, and logs a successful sign-in.
-- Returns {ok, user_id} or {ok: false, error, locked_until}.
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

revoke all on function
  public.is_main_owner(uuid), public._require_main_owner(uuid),
  public.add_co_owner(text, text, text), public.reset_co_owner_pin(uuid, text),
  public.remove_co_owner(uuid), public.business_owners(uuid),
  public.login_kind(text), public.co_owner_pin_login(text, text)
from public, anon, authenticated;
grant execute on function
  public.is_main_owner(uuid),
  public.add_co_owner(text, text, text), public.reset_co_owner_pin(uuid, text),
  public.remove_co_owner(uuid), public.business_owners(uuid)
to authenticated;
grant execute on function public.login_kind(text), public.co_owner_pin_login(text, text) to service_role;
