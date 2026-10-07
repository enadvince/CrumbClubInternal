-- Public-read bucket for product and bundle photos; only owners may write,
-- and only under a folder named after their business id: <business_id>/<file>.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('photos', 'photos', true)
    on conflict (id) do nothing;

    execute $p$
      create policy photos_owner_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'photos' and public.is_owner(((storage.foldername(name))[1])::uuid))
    $p$;
    execute $p$
      create policy photos_owner_update on storage.objects for update to authenticated
      using (bucket_id = 'photos' and public.is_owner(((storage.foldername(name))[1])::uuid))
    $p$;
    execute $p$
      create policy photos_owner_delete on storage.objects for delete to authenticated
      using (bucket_id = 'photos' and public.is_owner(((storage.foldername(name))[1])::uuid))
    $p$;
  end if;
end $$;
