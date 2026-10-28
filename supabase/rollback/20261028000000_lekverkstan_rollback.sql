-- Tar bort allt från 20261028000000_lekverkstan.sql. OBS: alla lekar och samlingar raderas.
begin;
drop trigger if exists lv_require_invite on auth.users;
drop function if exists public.lv_require_invite();
drop function if exists public.lv_create_invite(text);
drop table if exists public.lv_alara_usage;
drop table if exists public.lv_alara_cache;
drop table if exists public.lv_invites;
drop table if exists public.lv_collection;
drop table if exists public.lv_decks;
drop function if exists public.lv_decks_touch();
commit;
