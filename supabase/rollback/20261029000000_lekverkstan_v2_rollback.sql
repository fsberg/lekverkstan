-- Återställer 20261029000000_lekverkstan_v2.sql. OBS: spellogg, namn, versioner och bytesmarkeringar raderas.
begin;
drop table if exists public.lv_games;
drop policy if exists "Bytesbörsen syns" on public.lv_collection;
alter table public.lv_collection drop constraint if exists lv_collection_for_trade_check, drop column if exists for_trade;
drop policy if exists "Publika lekar syns" on public.lv_decks;
alter table public.lv_decks drop column if exists versions, drop column if exists public;
drop table if exists public.lv_profiles;
commit;
