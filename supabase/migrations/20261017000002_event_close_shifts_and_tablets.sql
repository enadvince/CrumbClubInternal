-- 1. Closing an event closes its open shifts. A tablet that never closed its shift
--    otherwise keeps showing "shift already open" against an event that is over.
--    The shift is marked closed without a cash count; the tablet can still close it
--    properly later (close_shift accepts a closed shift that has no count yet).
-- 2. Owners can see, rename and remove paired tablets (Tablets page). Removing a tablet
--    takes away its access right away; the app also bans its login so it is signed out.

-- ---------------------------------------------------------------------------
-- 1. Event close → shifts close
-- ---------------------------------------------------------------------------
create or replace function public._tg_event_closed_close_shifts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.shifts
     set status = 'closed', closed_at = now(), close_note = 'Closed automatically when the event was closed'
   where event_id = new.id and status = 'open';
  return null;
end $$;

drop trigger if exists events_closed_close_shifts on public.events;
create trigger events_closed_close_shifts after update of status on public.events
  for each row when (new.status = 'closed' and old.status is distinct from 'closed')
  execute function public._tg_event_closed_close_shifts();

-- Shifts left open on events that are already closed.
update public.shifts s
   set status = 'closed', closed_at = now(), close_note = 'Closed automatically when the event was closed'
  from public.events e
 where e.id = s.event_id and e.status = 'closed' and s.status = 'open';

-- ---------------------------------------------------------------------------
-- 2. Tablets
-- ---------------------------------------------------------------------------
alter table public.pos_devices add column if not exists removed_at timestamptz;

create or replace function public.rename_device(p_device_id uuid, p_label text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_device public.pos_devices;
  v_label text := nullif(trim(p_label), '');
begin
  select * into v_device from public.pos_devices where id = p_device_id;
  if v_device.id is null then perform public._fail('tablet not found'); end if;
  perform public._require_owner(v_device.business_id);
  if v_label is null then perform public._fail('enter a name for the tablet'); end if;
  if length(v_label) > 60 then perform public._fail('tablet name is too long'); end if;
  update public.pos_devices set label = v_label where id = v_device.id;
  if v_device.device_user_id is not null then
    update public.memberships set label = v_label
     where user_id = v_device.device_user_id and business_id = v_device.business_id and role = 'device';
  end if;
end $$;

-- Takes the tablet's access away: its device membership goes (every RPC and RLS check
-- needs it) and its open shift is closed. Its sales, shifts and code stay for history.
-- Returns the tablet's login so the caller can also ban it (signs it out for good).
create or replace function public.remove_device(p_device_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_device public.pos_devices;
begin
  select * into v_device from public.pos_devices where id = p_device_id for update;
  if v_device.id is null then perform public._fail('tablet not found'); end if;
  perform public._require_owner(v_device.business_id);
  if v_device.removed_at is null then
    update public.pos_devices set removed_at = now() where id = v_device.id;
    update public.shifts set status = 'closed', closed_at = now(), close_note = 'Closed automatically when the tablet was removed'
     where device_id = v_device.id and status = 'open';
    if v_device.device_user_id is not null then
      delete from public.memberships
       where user_id = v_device.device_user_id and business_id = v_device.business_id and role = 'device';
      delete from public.device_heartbeats where device_user_id = v_device.device_user_id;
    end if;
  end if;
  return jsonb_build_object('device_user_id', v_device.device_user_id, 'device_code', v_device.device_code);
end $$;

revoke all on function public.rename_device(uuid, text) from public, anon;
revoke all on function public.remove_device(uuid) from public, anon;
grant execute on function public.rename_device(uuid, text) to authenticated;
grant execute on function public.remove_device(uuid) to authenticated;
