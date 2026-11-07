-- Ångrar Lekverkstan v9. Kort som redan flyttats ligger kvar där de är; bara den automatiska flytten slutar.
begin;
drop trigger if exists lv_booking_move on public.lv_bookings;
drop function if exists public.lv_booking_move();
drop function if exists public.lv_collection_add(uuid, text, integer);
alter table public.lv_bookings drop column if exists moved;
commit;
