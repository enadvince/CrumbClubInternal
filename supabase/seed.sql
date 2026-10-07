-- Local development seed (runs on `supabase db reset`).
-- Creates a dev owner login and the sample Crumb Club menu:
--   email: owner@crumbclub.test   password: crumbclub123   owner PIN: 1234
--   staff PINs: 1111 (Staff One), 2222 (Staff Two)
-- Do not run this against production.
do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000001';
  v_business uuid;
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated',
    'owner@crumbclub.test', extensions.crypt('crumbclub123', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
  ) on conflict (id) do nothing;

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_user, v_user::text,
          jsonb_build_object('sub', v_user::text, 'email', 'owner@crumbclub.test', 'email_verified', true),
          'email', now(), now(), now())
  on conflict do nothing;

  if not exists (select 1 from public.memberships where user_id = v_user) then
    v_business := public._create_business_for(v_user, 'Crumb Club', 'Owner', '1234');
    perform public.load_sample_data(v_business);
    insert into public.discount_options (business_id, name, type, value, sort_order) values
      (v_business, 'Senior citizen / PWD', 'percent', 2000, 1),
      (v_business, 'Friends & family', 'percent', 1000, 2);
  end if;
end $$;
