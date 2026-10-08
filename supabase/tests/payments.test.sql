begin;
\ir _setup.sql

select pg_temp.login(pg_temp.ctx('device_a'));

-- Cash is final; QR is awaiting verification, even if the client claims otherwise.
select public.record_sale(pg_temp.sample_sale('d0000000-0000-4000-8000-000000000001'));
select public.record_sale(
  pg_temp.sample_sale('d0000000-0000-4000-8000-000000000002')
  || jsonb_build_object('payment_method', 'qr_ph', 'qr_reference', '5012345678901', 'cash_received_centavos', null,
                        'change_given_centavos', null, 'payment_status', 'verified'));
select pg_temp.check((select payment_status from public.transactions where id = 'd0000000-0000-4000-8000-000000000001') = 'paid', 'cash is paid');
select pg_temp.check((select payment_status from public.transactions where id = 'd0000000-0000-4000-8000-000000000002') = 'awaiting_verification', 'QR awaits verification');

-- The tablet can't verify a payment.
do $$ begin
  begin
    perform public.set_payment_verified('d0000000-0000-4000-8000-000000000002', true);
    raise exception 'ASSERTION FAILED: device verified a payment';
  exception when insufficient_privilege then null;
  end;
end $$;

-- The tablet links a photo inside its business folder only.
select public.attach_payment_photo('d0000000-0000-4000-8000-000000000002',
  pg_temp.ctx('biz_a')::text || '/d0000000-0000-4000-8000-000000000002.jpg');
select pg_temp.check((select payment_photo_path from public.transactions where id = 'd0000000-0000-4000-8000-000000000002') like '%.jpg', 'photo linked');
do $$ begin
  begin
    perform public.attach_payment_photo('d0000000-0000-4000-8000-000000000002', pg_temp.ctx('biz_b')::text || '/x.jpg');
    raise exception 'ASSERTION FAILED: photo outside business accepted';
  exception when raise_exception then
    if sqlerrm like 'ASSERTION%' then raise; end if;
  end;
end $$;

-- An owner verifies it, and can undo that.
select pg_temp.login(pg_temp.ctx('owner_a'));
select public.set_payment_verified('d0000000-0000-4000-8000-000000000002', true);
select pg_temp.check((select payment_status = 'verified' and payment_verified_by = pg_temp.ctx('owner_a')
  from public.transactions where id = 'd0000000-0000-4000-8000-000000000002'), 'owner verified');
select public.set_payment_verified('d0000000-0000-4000-8000-000000000002', false);
select pg_temp.check((select payment_status from public.transactions where id = 'd0000000-0000-4000-8000-000000000002') = 'awaiting_verification', 'unverified');

-- Another business's owner can't touch it.
select pg_temp.login(pg_temp.ctx('owner_b'));
do $$ begin
  begin
    perform public.set_payment_verified('d0000000-0000-4000-8000-000000000002', true);
    raise exception 'ASSERTION FAILED: other owner verified';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
