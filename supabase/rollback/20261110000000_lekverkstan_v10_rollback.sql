-- Ångrar Lekverkstan v10. Matcher som andra loggat åt en finns kvar som vanliga matcher. Appen går tillbaka till fritt skrivna namn.
begin;
drop function if exists public.lv_log_match(text, uuid[], integer, integer);
alter table public.lv_games drop constraint if exists lv_games_owner_match_key;
alter table public.lv_games drop column if exists logged_by;
alter table public.lv_games drop column if exists match_id;
commit;
