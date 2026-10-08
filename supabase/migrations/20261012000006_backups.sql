-- Backups and exports.
--  * Nightly at 23:30 Asia/Manila (15:30 UTC), pg_cron calls the daily-backup Edge Function,
--    which writes that day's CSVs to the private "backups" bucket at
--    YYYY/MM/DD/<business_id>/<table>.csv, logs the run in backup_runs, and deletes
--    backups older than the business's retention (365 days by default).
--  * Owners confirm their PIN before opening reports and exports (check_owner_pin).
-- The cron job reads two Vault secrets set outside migrations (see docs/offline-architecture.md):
--   crumbclub_project_url, crumbclub_backup_secret

alter table public.businesses
  add column backup_retention_days int not null default 365 check (backup_retention_days between 7 and 3650);
grant update (backup_retention_days) on public.businesses to authenticated;

create table public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  backup_date date not null,
  trigger text not null default 'cron' check (trigger in ('cron', 'manual')),
  status text not null check (status in ('running', 'success', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  row_counts jsonb,
  files text[],
  deleted_files int,
  emailed boolean,
  error text
);
create index backup_runs_business_idx on public.backup_runs (business_id, started_at desc);

alter table public.backup_runs enable row level security;
create policy backup_runs_owner_select on public.backup_runs for select to authenticated using (public.is_owner(business_id));
revoke all on public.backup_runs from anon, authenticated;
grant select on public.backup_runs to authenticated;

-- Owners: last run, last success, and whether a warning is due (no success in 48 hours).
create or replace function public.backup_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_business uuid;
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() and role = 'owner' order by created_at limit 1;
  if v_business is null then raise exception 'owner access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'last_success_at', (select max(finished_at) from public.backup_runs where business_id = v_business and status = 'success'),
    'stale', coalesce((select max(finished_at) from public.backup_runs where business_id = v_business and status = 'success')
                      < now() - interval '48 hours', true),
    'retention_days', (select backup_retention_days from public.businesses where id = v_business),
    'recent', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.started_at desc)
      from (select id, backup_date, trigger, status, started_at, finished_at, row_counts, deleted_files, emailed, error
            from public.backup_runs where business_id = v_business order by started_at desc limit 14) r
    ), '[]'::jsonb)
  );
end $$;

-- Owner PIN check for reports and exports on the owner pages. Logs the access.
create or replace function public.check_owner_pin(p_pin text, p_action text default 'reports_access')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_business uuid;
  v_staff public.staff;
begin
  select business_id into v_business from public.memberships
   where user_id = auth.uid() and role = 'owner' order by created_at limit 1;
  if v_business is null then raise exception 'owner access required' using errcode = '42501'; end if;
  if p_action not in ('reports_access', 'export') then perform public._fail('unknown action'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then perform public._fail('Enter a 4-digit owner PIN'); end if;
  select * into v_staff from public.staff s
   where s.business_id = v_business and s.active and s.role = 'owner' and s.pin_hash is not null
     and extensions.crypt(p_pin, s.pin_hash) = s.pin_hash
   limit 1;
  if v_staff.id is null then perform public._fail('That isn''t an owner PIN'); end if;
  perform public._audit(v_business, jsonb_build_object('action', p_action, 'manager_staff_id', v_staff.id));
  return jsonb_build_object('staff_id', v_staff.id, 'name', v_staff.name);
end $$;

revoke all on function public.backup_status(), public.check_owner_pin(text, text) from public, anon;
grant execute on function public.backup_status(), public.check_owner_pin(text, text) to authenticated;

-- Private bucket. Owners can download their own business's files:
-- YYYY/MM/DD/<business_id>/<file>.csv → folder 4 is the business.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('backups', 'backups', false) on conflict (id) do nothing;
    execute $p$
      create policy backups_owner_select on storage.objects for select to authenticated
      using (bucket_id = 'backups' and public.is_owner(((storage.foldername(name))[4])::uuid))
    $p$;
  end if;
end $$;

-- Nightly schedule (Supabase only: pg_cron and pg_net aren't in the plain-Postgres test harness).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'crumbclub-daily-backup';
    perform cron.schedule(
      'crumbclub-daily-backup',
      '30 15 * * *', -- 23:30 Asia/Manila
      $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'crumbclub_project_url') || '/functions/v1/daily-backup',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-backup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'crumbclub_backup_secret')),
          body := jsonb_build_object('trigger', 'cron'),
          timeout_milliseconds := 120000
        );
      $job$
    );
  end if;
end $$;
