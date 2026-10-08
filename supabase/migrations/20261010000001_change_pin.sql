-- Changing a PIN needs the current PIN. set_staff_pin() now only sets a
-- first PIN; change_staff_pin() replaces one after checking the current PIN.

create or replace function public.set_staff_pin(p_staff_id uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_staff public.staff;
begin
  select * into v_staff from public.staff where id = p_staff_id;
  if v_staff.id is null then perform public._fail('staff not found'); end if;
  perform public._require_owner(v_staff.business_id);
  if v_staff.pin_hash is not null then
    perform public._fail('This person already has a PIN. Enter the current PIN to change it.');
  end if;
  perform public._check_pin(v_staff.business_id, p_pin, p_staff_id);
  update public.staff set pin_hash = public._hash_pin(p_pin) where id = p_staff_id;
end $$;

create or replace function public.change_staff_pin(p_staff_id uuid, p_current_pin text, p_new_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_staff public.staff;
begin
  select * into v_staff from public.staff where id = p_staff_id;
  if v_staff.id is null then perform public._fail('staff not found'); end if;
  perform public._require_owner(v_staff.business_id);
  if v_staff.pin_hash is not null
     and (coalesce(p_current_pin, '') !~ '^[0-9]{4}$'
          or extensions.crypt(p_current_pin, v_staff.pin_hash) <> v_staff.pin_hash) then
    perform public._fail('The current PIN is incorrect. The PIN was not changed.');
  end if;
  perform public._check_pin(v_staff.business_id, p_new_pin, p_staff_id);
  update public.staff set pin_hash = public._hash_pin(p_new_pin) where id = p_staff_id;
end $$;

revoke all on function public.change_staff_pin(uuid, text, text) from public, anon;
grant execute on function public.change_staff_pin(uuid, text, text) to authenticated;
