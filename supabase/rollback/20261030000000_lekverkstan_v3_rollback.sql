-- Återställer 20261030000000_lekverkstan_v3.sql. OBS: önskelistor och utlånsanteckningar raderas.
begin;
drop table if exists public.lv_loans;
drop table if exists public.lv_wishlist;
commit;
