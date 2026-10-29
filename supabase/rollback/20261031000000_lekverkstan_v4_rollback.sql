-- Ångra Lekverkstan v4 (bokningar försvinner, utgåvor och datum i samlingen tas bort).
begin;
drop table if exists public.lv_bookings;
alter table public.lv_collection drop column if exists prints, drop column if exists added;
commit;
