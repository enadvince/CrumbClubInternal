-- The daily-backup Edge Function checks the cron's x-backup-secret header against the same
-- Vault secret the cron job sends (crumbclub_backup_secret), so the secret only ever lives in
-- Vault: no copy in the function's environment. Only the service role (the function) can ask.
create or replace function public.backup_secret_matches(p_secret text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null then return false; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into v_secret using 'crumbclub_backup_secret';
  return v_secret is not null and length(v_secret) >= 32 and p_secret = v_secret;
end $$;

revoke all on function public.backup_secret_matches(text) from public, anon, authenticated;
grant execute on function public.backup_secret_matches(text) to service_role;
