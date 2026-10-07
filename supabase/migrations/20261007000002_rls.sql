-- Row Level Security. Every table is scoped by business_id.
--   owner  → full read/write on their business's rows
--   device → read-only on the live menu; all writes go through SECURITY DEFINER RPCs
--   anon   → nothing

-- ---------------------------------------------------------------------------
-- Membership helpers (SECURITY DEFINER so they can read memberships under RLS)
-- ---------------------------------------------------------------------------
create or replace function public.is_member(p_business uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and business_id = p_business
  );
$$;

create or replace function public.is_owner(p_business uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid() and business_id = p_business and role = 'owner'
  );
$$;

create or replace function public.my_role(p_business uuid)
returns public.member_role
language sql stable security definer set search_path = public
as $$
  select role from public.memberships
  where user_id = auth.uid() and business_id = p_business;
$$;

revoke all on function public.is_member(uuid) from public, anon;
revoke all on function public.is_owner(uuid) from public, anon;
revoke all on function public.my_role(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;
grant execute on function public.my_role(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.memberships enable row level security;
alter table public.staff enable row level security;
alter table public.products enable row level security;
alter table public.bundles enable row level security;
alter table public.bundle_items enable row level security;
alter table public.events enable row level security;
alter table public.event_products enable row level security;
alter table public.event_bundles enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_lines enable row level security;
alter table public.transaction_line_components enable row level security;
alter table public.stock_adjustments enable row level security;
alter table public.cash_sessions enable row level security;
alter table public.device_heartbeats enable row level security;

-- anon gets nothing at all
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- businesses / memberships
-- ---------------------------------------------------------------------------
create policy businesses_select on public.businesses
  for select to authenticated using (public.is_member(id));
create policy businesses_update on public.businesses
  for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));

create policy memberships_select_self on public.memberships
  for select to authenticated using (user_id = auth.uid() or public.is_owner(business_id));
create policy memberships_owner_delete on public.memberships
  for delete to authenticated using (public.is_owner(business_id) and user_id <> auth.uid());

-- ---------------------------------------------------------------------------
-- staff: owners only. The tablet gets names + PIN hashes via device_bootstrap().
-- pin_hash is written only via set_staff_pin().
-- ---------------------------------------------------------------------------
create policy staff_owner_all on public.staff
  for all to authenticated
  using (public.is_owner(business_id)) with check (public.is_owner(business_id));

-- ---------------------------------------------------------------------------
-- Catalog and menu: owners write; any member (incl. device) reads.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['products', 'bundles', 'bundle_items', 'events', 'event_products', 'event_bundles']
  loop
    execute format(
      'create policy %1$s_member_select on public.%1$s for select to authenticated using (public.is_member(business_id))', t);
    execute format(
      'create policy %1$s_owner_insert on public.%1$s for insert to authenticated with check (public.is_owner(business_id))', t);
    execute format(
      'create policy %1$s_owner_update on public.%1$s for update to authenticated using (public.is_owner(business_id)) with check (public.is_owner(business_id))', t);
    execute format(
      'create policy %1$s_owner_delete on public.%1$s for delete to authenticated using (public.is_owner(business_id))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Sales: owners read everything; the device reads sales of the live event
-- (for "my shift" and duplicate-QR checks). All writes go through RPCs.
-- Never hard-deleted.
-- ---------------------------------------------------------------------------
create policy transactions_select on public.transactions
  for select to authenticated using (
    public.is_owner(business_id)
    or (public.is_member(business_id) and exists (
      select 1 from public.events e where e.id = event_id and e.status = 'live'))
  );
create policy transaction_lines_select on public.transaction_lines
  for select to authenticated using (
    exists (select 1 from public.transactions t where t.id = transaction_id)
  );
create policy tlc_select on public.transaction_line_components
  for select to authenticated using (
    exists (select 1 from public.transactions t where t.id = transaction_id)
  );

create policy stock_adjustments_select on public.stock_adjustments
  for select to authenticated using (public.is_member(business_id));

create policy cash_sessions_owner_select on public.cash_sessions
  for select to authenticated using (public.is_owner(business_id));

create policy device_heartbeats_owner_select on public.device_heartbeats
  for select to authenticated using (public.is_owner(business_id));

-- Table privileges for the authenticated role (RLS still applies on top).
-- Postgres column grants only restrict when there is no table-wide grant, so
-- update rights are granted per column. Trigger-maintained stock columns and
-- pin_hash (set via set_staff_pin) are deliberately left out.
revoke all on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant insert, delete on
  public.products, public.bundles, public.bundle_items,
  public.events, public.event_products, public.event_bundles
  to authenticated;
grant update on public.products, public.bundles, public.bundle_items, public.event_bundles to authenticated;
grant update (name, venue, starts_on, ends_on, low_stock_threshold) on public.events to authenticated;
grant update (price_centavos, starting_stock, is_available, sort_order) on public.event_products to authenticated;
grant insert (business_id, name, role, active) on public.staff to authenticated;
grant update (name, role, active) on public.staff to authenticated;
grant update (name) on public.businesses to authenticated;
grant delete on public.memberships to authenticated;
-- The device must never read PIN hashes or staff rows directly (device_bootstrap() does that).
