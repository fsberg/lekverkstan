-- Tar bort v7. Appen döljer topplista, spelkväll och värdekurva när de saknas. Spelkvällar och värdelogg försvinner.
drop table if exists public.lv_event_replies;
drop table if exists public.lv_events;
drop function if exists public.lv_leaderboard();
alter table public.lv_profiles drop column if exists share_games;
drop table if exists public.lv_value_log;
