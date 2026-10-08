-- Payments taken offline.
--  * Cash is final as soon as the tablet records it ('paid').
--  * QR payments are always stored 'awaiting_verification', whatever the tablet sends,
--    and only an owner can mark them 'verified'. Never verified automatically.
--  * An optional photo of the payment confirmation is uploaded to the private
--    payment-proofs bucket and linked to the order.

create type public.payment_status as enum ('paid', 'awaiting_verification', 'verified');

alter table public.transactions
  add column payment_status public.payment_status not null default 'paid',
  add column payment_verified_at timestamptz,
  add column payment_verified_by uuid references auth.users (id),
  add column payment_photo_path text;

update public.transactions set payment_status = 'awaiting_verification' where payment_method = 'qr_ph';

-- Whatever a client sends, a new order's payment status follows its method.
create or replace function public._tg_transactions_payment_status()
returns trigger language plpgsql set search_path = public as $$
begin
  new.payment_status := case when new.payment_method = 'qr_ph' then 'awaiting_verification' else 'paid' end;
  new.payment_verified_at := null;
  new.payment_verified_by := null;
  return new;
end $$;

create trigger transactions_payment_status
  before insert on public.transactions
  for each row execute function public._tg_transactions_payment_status();

create index transactions_awaiting_idx on public.transactions (business_id, client_created_at)
  where payment_status = 'awaiting_verification';

-- Owner ticks (or unticks) a QR payment after matching it in the GCash merchant history.
create or replace function public.set_payment_verified(p_transaction_id uuid, p_verified boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_txn public.transactions;
begin
  select * into v_txn from public.transactions where id = p_transaction_id for update;
  if v_txn.id is null then raise exception 'transaction not found' using errcode = 'P0002'; end if;
  perform public._require_owner(v_txn.business_id);
  if v_txn.payment_method <> 'qr_ph' then perform public._fail('only QR payments need verifying'); end if;
  update public.transactions set
    payment_status = case when p_verified then 'verified' else 'awaiting_verification' end::public.payment_status,
    payment_verified_at = case when p_verified then now() end,
    payment_verified_by = case when p_verified then auth.uid() end
  where id = v_txn.id;
  return jsonb_build_object('status', 'ok', 'payment_status', case when p_verified then 'verified' else 'awaiting_verification' end);
end $$;

-- The tablet links an uploaded photo to an order. Idempotent; the path must be in the
-- business's own folder: <business_id>/<transaction_id>.jpg
create or replace function public.attach_payment_photo(p_transaction_id uuid, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_txn public.transactions;
begin
  select * into v_txn from public.transactions where id = p_transaction_id;
  if v_txn.id is null then perform public._fail('order not found; it must sync before its photo'); end if;
  perform public._require_member(v_txn.business_id);
  if split_part(coalesce(p_path, ''), '/', 1) <> v_txn.business_id::text then
    perform public._fail('photo path is outside this business');
  end if;
  update public.transactions set payment_photo_path = p_path where id = v_txn.id;
  return jsonb_build_object('status', 'ok');
end $$;

revoke all on function public._tg_transactions_payment_status() from public, anon, authenticated;
revoke all on function public.set_payment_verified(uuid, boolean) from public, anon;
revoke all on function public.attach_payment_photo(uuid, text) from public, anon;
grant execute on function public.set_payment_verified(uuid, boolean), public.attach_payment_photo(uuid, text) to authenticated;

-- Private bucket for payment photos. Members (incl. the tablet) upload into their
-- business folder; only owners can read them back.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('payment-proofs', 'payment-proofs', false)
    on conflict (id) do nothing;

    execute $p$
      create policy payment_proofs_member_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'payment-proofs' and public.is_member(((storage.foldername(name))[1])::uuid))
    $p$;
    execute $p$
      create policy payment_proofs_owner_select on storage.objects for select to authenticated
      using (bucket_id = 'payment-proofs' and public.is_owner(((storage.foldername(name))[1])::uuid))
    $p$;
  end if;
end $$;
