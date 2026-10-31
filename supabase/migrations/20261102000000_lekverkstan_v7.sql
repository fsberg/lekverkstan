-- Lekverkstan v7: samlingens värde över tid, topplista (frivillig) och spelkvällar.
-- Rör inga familjetabeller.

-- ---------- värdelogg, en rad per dygn och privat ----------
create table public.lv_value_log (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null default current_date,
  value_eur numeric(12, 2) not null check (value_eur >= 0),
  cards integer not null default 0 check (cards >= 0),
  prices jsonb not null default '{}' check (jsonb_typeof(prices) = 'object' and pg_column_size(prices) < 40000),
  primary key (owner, day)
);
alter table public.lv_value_log enable row level security;
revoke all on public.lv_value_log from anon, authenticated;
grant select, insert, update, delete on public.lv_value_log to authenticated;
create policy "Egen värdelogg" on public.lv_value_log for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- ---------- topplista: den som vill delar sina matcher, anteckningar lämnar aldrig tabellen ----------
alter table public.lv_profiles add column share_games boolean not null default false;

create function public.lv_leaderboard()
returns table (player text, deck_name text, played_on date, result text, players integer, opponents text)
language sql stable security definer set search_path = '' as $$
  select p.display_name, g.deck_name, g.played_on, g.result, g.players, g.opponents
  from public.lv_games g
  join public.lv_profiles p on p.user_id = g.owner
  where p.share_games and auth.uid() is not null
  order by g.played_on desc, g.created desc
  limit 5000;
$$;
revoke all on function public.lv_leaderboard() from public, anon;
grant execute on function public.lv_leaderboard() to authenticated;

-- ---------- spelkvällar: syns för alla inloggade ----------
create table public.lv_events (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  place text not null default '' check (char_length(place) <= 120),
  note text not null default '' check (char_length(note) <= 500),
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 1 and 6),
  chosen text check (char_length(chosen) <= 16),
  pods jsonb not null default '[]' check (jsonb_typeof(pods) = 'array' and pg_column_size(pods) < 20000),
  created timestamptz not null default now(),
  updated timestamptz not null default now()
);
create index lv_events_owner_idx on public.lv_events (owner);
alter table public.lv_events enable row level security;
revoke all on public.lv_events from anon, authenticated;
grant select, insert, update, delete on public.lv_events to authenticated;
create policy "Spelkvällar syns för inloggade" on public.lv_events for select to authenticated using (true);
create policy "Egen spelkväll skapas" on public.lv_events for insert to authenticated with check (owner = (select auth.uid()));
create policy "Egen spelkväll ändras" on public.lv_events for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "Egen spelkväll tas bort" on public.lv_events for delete to authenticated using (owner = (select auth.uid()));

create table public.lv_event_replies (
  event uuid not null references public.lv_events (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  dates jsonb not null default '[]' check (jsonb_typeof(dates) = 'array' and jsonb_array_length(dates) <= 6),
  deck_name text not null default '' check (char_length(deck_name) <= 80),
  bracket integer check (bracket between 1 and 5),
  updated timestamptz not null default now(),
  primary key (event, user_id)
);
create index lv_event_replies_user_idx on public.lv_event_replies (user_id);
alter table public.lv_event_replies enable row level security;
revoke all on public.lv_event_replies from anon, authenticated;
grant select, insert, update, delete on public.lv_event_replies to authenticated;
create policy "Svar syns för inloggade" on public.lv_event_replies for select to authenticated using (true);
create policy "Eget svar skapas" on public.lv_event_replies for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Eget svar ändras" on public.lv_event_replies for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Eget svar tas bort" on public.lv_event_replies for delete to authenticated using (user_id = (select auth.uid()));
