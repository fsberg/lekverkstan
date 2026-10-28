-- Tar bort allt från 20261028000000_lekverkstan.sql. OBS: alla lekar och samlingar raderas.
begin;
drop trigger if exists require_invite on auth.users;
drop function if exists public.require_invite();
drop function if exists public.create_invite(text);
drop table if exists public.alara_usage;
drop table if exists public.alara_cache;
drop table if exists public.invites;
drop table if exists public.collection;
drop table if exists public.decks;
drop function if exists public.decks_touch();
commit;
