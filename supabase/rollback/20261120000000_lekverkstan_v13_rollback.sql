-- Ångrar Manakeep v13 (turneringar i molnet). Matcher som redan sparats i spelloggen finns kvar.
begin;
drop function if exists public.lv_tour_log(uuid, integer, integer);
drop function if exists public.lv_tour_delete(uuid);
drop function if exists public.lv_tour_save(uuid, jsonb, integer, boolean, integer);
drop function if exists public.lv_tour_start(uuid, jsonb, integer);
drop function if exists public.lv_tour_respond(uuid, boolean, uuid);
drop function if exists public.lv_tour_create(text, text, integer, integer, uuid[], uuid);
drop function if exists public.lv_tour_deck(uuid);
drop table if exists public.lv_tour_players;
drop table if exists public.lv_tournaments;
drop function if exists public.lv_my_tours();
commit;
