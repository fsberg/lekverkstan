-- Lekverkstan v2: visningsnamn, publika lekar, versioner, bytesbörs och spellogg.
-- Rör inga familjetabeller.
begin;

-- ---------- visningsnamn (syns för inloggade, t.ex. på publika lekar och i bytesbörsen) ----------
create table public.lv_profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  created_at timestamptz not null default now()
);
alter table public.lv_profiles enable row level security;
revoke all on public.lv_profiles from anon, authenticated;
grant select, insert, update on public.lv_profiles to authenticated;
create policy "Namn syns för inloggade" on public.lv_profiles for select to authenticated using (true);
create policy "Eget namn skapas" on public.lv_profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Eget namn ändras" on public.lv_profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- lekar: publik-flagga och versioner ----------
alter table public.lv_decks
  add column public boolean not null default false,
  add column versions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(versions) = 'array' and pg_column_size(versions) < 400000);
create policy "Publika lekar syns" on public.lv_decks for select to authenticated using (public);

-- ---------- samling: antal till byte ----------
alter table public.lv_collection
  add column for_trade integer not null default 0,
  add constraint lv_collection_for_trade_check check (for_trade between 0 and qty);
create policy "Bytesbörsen syns" on public.lv_collection for select to authenticated using (for_trade > 0);

-- ---------- spellogg (privat) ----------
create table public.lv_games (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  deck_id uuid references public.lv_decks (id) on delete set null,
  deck_name text not null check (char_length(deck_name) between 1 and 80),
  played_on date not null default current_date,
  result text not null check (result in ('win', 'loss', 'draw')),
  players integer not null default 2 check (players between 2 and 10),
  opponents text not null default '' check (char_length(opponents) <= 300),
  notes text not null default '' check (char_length(notes) <= 1000),
  created timestamptz not null default now()
);
create index lv_games_owner_idx on public.lv_games (owner, played_on desc);
create index lv_games_deck_idx on public.lv_games (deck_id);
alter table public.lv_games enable row level security;
revoke all on public.lv_games from anon, authenticated;
grant select, insert, update, delete on public.lv_games to authenticated;
create policy "Egna matcher" on public.lv_games for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

commit;
