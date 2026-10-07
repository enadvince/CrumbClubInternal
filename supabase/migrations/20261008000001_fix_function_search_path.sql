-- Supabase security advisor: pin search_path on the two helpers that lacked it.
alter function public._fail(text) set search_path = public;
alter function public._tg_touch_updated_at() set search_path = public;
