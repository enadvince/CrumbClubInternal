-- Owner invites: an owner invites someone by email. The email carries a link
-- with a one-time token; the invitee creates an account with that email (or
-- signs in to an existing one) and becomes an owner of the business.
-- Only a SHA-256 hash of the token is stored.

create table public.owner_invites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  email text not null check (email = lower(trim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  token_hash text not null unique,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz
);
create index owner_invites_business_idx on public.owner_invites (business_id, created_at desc);
-- At most one open invite per email per business (re-inviting replaces it).
create unique index owner_invites_one_open on public.owner_invites (business_id, email)
  where accepted_at is null and revoked_at is null;

alter table public.owner_invites enable row level security;
create policy owner_invites_owner_select on public.owner_invites
  for select to authenticated using (public.is_owner(business_id));
revoke all on public.owner_invites from anon, authenticated;
-- token_hash is left out: owners see who was invited, not the token.
grant select (id, business_id, email, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at)
  on public.owner_invites to authenticated;

create or replace function public._invite_token_hash(p_token text)
returns text language sql immutable set search_path = public, extensions as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

-- Creates (or replaces) an invite for p_email and returns the plain token.
-- This is the only time the token is available; the caller emails the link.
create or replace function public.create_owner_invite(p_email text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_business uuid;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_invite public.owner_invites;
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() and role = 'owner' order by created_at limit 1;
  if v_business is null then raise exception 'owner access required' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform public._fail('Enter a valid email address'); end if;
  if exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
    where m.business_id = v_business and m.role = 'owner' and lower(u.email) = v_email
  ) then
    perform public._fail('That person is already an owner');
  end if;

  update public.owner_invites set revoked_at = now()
   where business_id = v_business and email = v_email and accepted_at is null and revoked_at is null;
  insert into public.owner_invites (business_id, email, token_hash, invited_by)
    values (v_business, v_email, public._invite_token_hash(v_token), auth.uid())
    returning * into v_invite;

  return jsonb_build_object(
    'id', v_invite.id, 'email', v_invite.email, 'token', v_token, 'expires_at', v_invite.expires_at,
    'business_name', (select name from public.businesses where id = v_business),
    'invited_by_name', (select name from public.staff where business_id = v_business and user_id = auth.uid()
                         order by created_at limit 1)
  );
end $$;

create or replace function public.revoke_owner_invite(p_invite_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_invite public.owner_invites;
begin
  select * into v_invite from public.owner_invites where id = p_invite_id;
  if v_invite.id is null then perform public._fail('invite not found'); end if;
  perform public._require_owner(v_invite.business_id);
  update public.owner_invites set revoked_at = now()
   where id = p_invite_id and accepted_at is null and revoked_at is null;
end $$;

-- Public lookup for the invite page (callable without signing in). The token
-- is 256 random bits, so it can't be guessed; nothing is returned without it.
create or replace function public.get_owner_invite(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v_invite public.owner_invites;
begin
  select * into v_invite from public.owner_invites where token_hash = public._invite_token_hash(coalesce(p_token, ''));
  if v_invite.id is null then return null; end if;
  return jsonb_build_object(
    'email', v_invite.email,
    'business_name', (select name from public.businesses where id = v_invite.business_id),
    'status', case
      when v_invite.accepted_at is not null then 'accepted'
      when v_invite.revoked_at is not null then 'revoked'
      when v_invite.expires_at <= now() then 'expired'
      else 'pending' end,
    'account_exists', exists (select 1 from auth.users where lower(email) = v_invite.email)
  );
end $$;

-- The signed-in invitee accepts: becomes an owner, with a staff row and PIN
-- for the POS tablet. Their login email must match the invited email.
create or replace function public.accept_owner_invite(p_token text, p_name text, p_pin text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_invite public.owner_invites;
  v_email text;
begin
  if auth.uid() is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select * into v_invite from public.owner_invites
   where token_hash = public._invite_token_hash(coalesce(p_token, '')) for update;
  if v_invite.id is null then perform public._fail('This invite link is not valid'); end if;
  if v_invite.accepted_at is not null then perform public._fail('This invite has already been used'); end if;
  if v_invite.revoked_at is not null then perform public._fail('This invite was cancelled. Ask for a new one.'); end if;
  if v_invite.expires_at <= now() then perform public._fail('This invite has expired. Ask for a new one.'); end if;

  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is distinct from v_invite.email then
    perform public._fail('This invite is for ' || v_invite.email || '. Sign in with that email.');
  end if;
  if exists (select 1 from public.memberships where user_id = auth.uid()) then
    perform public._fail('This account already belongs to a business');
  end if;
  if length(trim(coalesce(p_name, ''))) = 0 then perform public._fail('Enter your name'); end if;
  perform public._check_pin(v_invite.business_id, p_pin, null);

  insert into public.memberships (user_id, business_id, role) values (auth.uid(), v_invite.business_id, 'owner');
  insert into public.staff (business_id, name, role, user_id, pin_hash)
    values (v_invite.business_id, trim(p_name), 'owner', auth.uid(), public._hash_pin(p_pin));
  update public.owner_invites set accepted_at = now(), accepted_by = auth.uid() where id = v_invite.id;
  return v_invite.business_id;
end $$;

-- Owners of the caller's business, with login emails (for the Owners page).
create or replace function public.business_owners(p_business uuid)
returns table (user_id uuid, email text, name text, joined_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_owner(p_business);
  return query
    select m.user_id, u.email::text,
      (select s.name from public.staff s where s.business_id = p_business and s.user_id = m.user_id
        order by s.created_at limit 1),
      m.created_at
    from public.memberships m join auth.users u on u.id = m.user_id
    where m.business_id = p_business and m.role = 'owner'
    order by m.created_at;
end $$;

revoke all on function
  public._invite_token_hash(text),
  public.create_owner_invite(text),
  public.revoke_owner_invite(uuid),
  public.get_owner_invite(text),
  public.accept_owner_invite(text, text, text),
  public.business_owners(uuid)
from public, anon, authenticated;
grant execute on function
  public.create_owner_invite(text),
  public.revoke_owner_invite(uuid),
  public.accept_owner_invite(text, text, text),
  public.business_owners(uuid)
to authenticated;
grant execute on function public.get_owner_invite(text) to anon, authenticated, service_role;
