-- Manakeep v13: turneringar i molnet. Arrangören bjuder in användare ur sina grupper, de tackar ja och väljer lek.
-- Matcherna sparas hos varje spelare med rätt lek. Rör inga familjetabeller. Kräver v12.
begin;

create table public.lv_tournaments (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  kind text not null check (kind in ('duel', 'pod')),           -- 1 mot 1 bäst av tre, eller Commander-bord
  life integer not null default 20 check (life in (20, 25, 30, 40)),
  rounds integer not null default 3 check (rounds between 1 and 8),
  status text not null default 'invite' check (status in ('invite', 'running', 'done')),
  state jsonb not null default '{}'::jsonb check (pg_column_size(state) < 65536), -- parningar och resultat
  ver integer not null default 0,                              -- ökar vid varje sparning, så att ingen skriver över någon annan
  num bigint not null default (extract(epoch from clock_timestamp()) * 1000)::bigint, -- bas för matchernas match_id
  created timestamptz not null default now(),
  updated timestamptz not null default now()
);
create table public.lv_tour_players (
  tour_id uuid not null references public.lv_tournaments (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'accepted', 'declined')),
  deck_id uuid references public.lv_decks (id) on delete set null,
  deck_name text not null default '' check (char_length(deck_name) <= 80),
  updated timestamptz not null default now(),
  primary key (tour_id, user_id)
);
create index lv_tour_players_user_idx on public.lv_tour_players (user_id);

alter table public.lv_tournaments enable row level security;
alter table public.lv_tour_players enable row level security;
revoke all on public.lv_tournaments, public.lv_tour_players from anon, authenticated;
grant select on public.lv_tournaments, public.lv_tour_players to authenticated; -- allt som ändrar går via funktionerna

create function public.lv_my_tours() returns setof uuid
language sql stable security definer set search_path = '' as $fn$
  select tour_id from public.lv_tour_players where user_id = auth.uid()
  union select id from public.lv_tournaments where owner = auth.uid();
$fn$;
revoke all on function public.lv_my_tours() from public, anon;
grant execute on function public.lv_my_tours() to authenticated;

create policy "Mina turneringar syns" on public.lv_tournaments for select to authenticated
  using (id in (select public.lv_my_tours()));
create policy "Deltagare i mina turneringar syns" on public.lv_tour_players for select to authenticated
  using (tour_id in (select public.lv_my_tours()));

-- egen lek eller ingen
create function public.lv_tour_deck(p_deck uuid) returns text
language sql stable security definer set search_path = '' as $fn$
  select coalesce((select left(name, 80) from public.lv_decks where id = p_deck and owner = auth.uid()), '');
$fn$;
revoke all on function public.lv_tour_deck(uuid) from public, anon, authenticated;

create function public.lv_tour_create(p_name text, p_kind text, p_life integer, p_rounds integer, p_players uuid[], p_deck uuid)
returns uuid language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); t uuid; dn text;
begin
  if me is null then raise exception 'Inte inloggad'; end if;
  if coalesce(array_length(p_players, 1), 0) < 1 or array_length(p_players, 1) > 31 then raise exception 'Bjud in mellan 1 och 31 spelare'; end if;
  if array_position(p_players, null) is not null or me = any (p_players) or (select count(distinct x) from unnest(p_players) x) <> array_length(p_players, 1) then raise exception 'Fel i spelarlistan'; end if;
  if exists (select 1 from unnest(p_players) x where x not in (select public.lv_mates())) then raise exception 'Alla måste vara med i en av dina grupper'; end if;
  if (select count(*) from public.lv_tournaments where owner = me and status <> 'done') >= 10 then raise exception 'Du har redan 10 pågående turneringar'; end if;
  dn := case when p_deck is null then '' else public.lv_tour_deck(p_deck) end;
  insert into public.lv_tournaments (owner, name, kind, life, rounds)
    values (me, left(btrim(p_name), 60), p_kind, p_life, greatest(1, least(8, coalesce(p_rounds, 3)))) returning id into t;
  insert into public.lv_tour_players (tour_id, user_id, status, deck_id, deck_name)
    values (t, me, 'accepted', case when dn = '' then null else p_deck end, dn);
  insert into public.lv_tour_players (tour_id, user_id) select t, x from unnest(p_players) x;
  return t;
end $fn$;

-- svara på inbjudan, eller byta lek innan turneringen startat
create function public.lv_tour_respond(p_tour uuid, p_accept boolean, p_deck uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare dn text := case when p_deck is null then '' else public.lv_tour_deck(p_deck) end;
begin
  if not exists (select 1 from public.lv_tournaments where id = p_tour and status = 'invite') then raise exception 'Turneringen har redan startat'; end if;
  update public.lv_tour_players set
    status = case when p_accept then 'accepted' else 'declined' end,
    deck_id = case when p_accept and dn <> '' then p_deck end,
    deck_name = case when p_accept then dn else '' end,
    updated = now()
  where tour_id = p_tour and user_id = auth.uid();
  if not found then raise exception 'Du är inte inbjuden'; end if;
end $fn$;

-- arrangören startar: state.players måste vara de som tackat ja
create function public.lv_tour_start(p_tour uuid, p_state jsonb, p_rounds integer)
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v integer;
begin
  if not exists (select 1 from public.lv_tournaments where id = p_tour and owner = auth.uid() and status = 'invite') then raise exception 'Bara arrangören kan starta, och bara en gång'; end if;
  if jsonb_typeof(p_state -> 'players') <> 'array' or jsonb_array_length(p_state -> 'players') < 2 then raise exception 'Minst två spelare behöver ha tackat ja'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_state -> 'players') x
             where not exists (select 1 from public.lv_tour_players p where p.tour_id = p_tour and p.status = 'accepted' and p.user_id::text = x))
     or (select count(distinct x) from jsonb_array_elements_text(p_state -> 'players') x) <> jsonb_array_length(p_state -> 'players')
  then raise exception 'Spelarna måste ha tackat ja'; end if;
  update public.lv_tournaments set status = 'running', state = p_state, rounds = greatest(1, least(8, coalesce(p_rounds, rounds))), ver = ver + 1, updated = now()
  where id = p_tour returning ver into v;
  return v;
end $fn$;

-- spara resultat och nya rundor. Alla som spelar får spara; p_ver måste vara den senaste versionen.
create function public.lv_tour_save(p_tour uuid, p_state jsonb, p_ver integer, p_done boolean, p_rounds integer)
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v integer; old jsonb;
begin
  if not exists (select 1 from public.lv_tour_players where tour_id = p_tour and user_id = auth.uid() and status = 'accepted')
     and not exists (select 1 from public.lv_tournaments where id = p_tour and owner = auth.uid())
  then raise exception 'Du är inte med i turneringen'; end if;
  select state into old from public.lv_tournaments where id = p_tour and status <> 'invite';
  if old is null then raise exception 'Turneringen har inte startat'; end if;
  if (p_state -> 'players') is distinct from (old -> 'players') then raise exception 'Spelarna kan inte ändras'; end if;
  update public.lv_tournaments set state = p_state, ver = ver + 1, updated = now(),
    status = case when p_done then 'done' else 'running' end,
    rounds = greatest(1, least(8, coalesce(p_rounds, rounds)))
  where id = p_tour and ver = p_ver returning ver into v;
  if v is null then raise exception 'Turneringen har ändrats av någon annan – laddar om'; end if;
  return v;
end $fn$;

create function public.lv_tour_delete(p_tour uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  delete from public.lv_tournaments where id = p_tour and owner = auth.uid();
  if not found then raise exception 'Bara arrangören kan ta bort turneringen'; end if;
end $fn$;

-- en färdig match sparas i spelloggen hos alla som spelade, med deras lek. Går att anropa flera gånger.
create function public.lv_tour_log(p_tour uuid, p_round integer, p_index integer)
returns integer language plpgsql security definer set search_path = '' as $fn$
declare
  t public.lv_tournaments; m jsonb; ids uuid[]; nm text[]; winner integer; res text; outcome text;
  x integer; y integer; mid text; added integer := 0; cnt integer; i integer; r text;
begin
  select * into t from public.lv_tournaments where id = p_tour and status <> 'invite';
  if t.id is null or not exists (select 1 from public.lv_tour_players where tour_id = p_tour and user_id = auth.uid() and status = 'accepted') then raise exception 'Du är inte med i turneringen'; end if;
  if p_round < 0 or p_round > 7 or p_index < 0 or p_index > 99 then raise exception 'Ogiltig match'; end if;
  m := t.state -> 'rounds' -> p_round -> p_index;
  if m is null then raise exception 'Matchen finns inte'; end if;
  -- spelarna i matchen, som index i state.players
  if t.kind = 'duel' then
    if coalesce((m ->> 'b')::integer, -1) < 0 or coalesce(m ->> 'res', '') !~ '^[0-3]-[0-3](-[0-3])?$' then return 0; end if;
    ids := array[(t.state -> 'players' ->> ((m ->> 'a')::integer))::uuid, (t.state -> 'players' ->> ((m ->> 'b')::integer))::uuid];
    x := split_part(m ->> 'res', '-', 1)::integer; y := split_part(m ->> 'res', '-', 2)::integer;
    winner := case when x > y then 1 when y > x then 2 end;
    res := ' ' || replace(m ->> 'res', '-', '–');
  else
    if jsonb_typeof(m -> 'p') <> 'array' or (m ->> 'w') is null then return 0; end if;
    select array_agg((t.state -> 'players' ->> (e::integer))::uuid order by o) into ids from jsonb_array_elements_text(m -> 'p') with ordinality q(e, o);
    winner := case when (m ->> 'w')::integer < 0 then null else array_position(array(select e::integer from jsonb_array_elements_text(m -> 'p') e), (m ->> 'w')::integer) end;
    res := '';
  end if;
  if array_position(ids, null) is not null or coalesce(array_length(ids, 1), 0) < 2 then raise exception 'Fel i matchen'; end if;
  select array_agg(coalesce(nullif(btrim(p.display_name), ''), 'Okänd') order by u.o) into nm
    from unnest(ids) with ordinality u(id, o) left join public.lv_profiles p on p.user_id = u.id;
  outcome := case when winner is null then 'oavgjort' else nm[winner] || ' vann' end;
  mid := 'tur-' || t.num || p_round || lpad(p_index::text, 2, '0');
  for i in 1 .. array_length(ids, 1) loop
    r := case when winner is null then 'draw' when winner = i then 'win' else 'loss' end;
    insert into public.lv_games (owner, deck_id, deck_name, result, players, opponents, notes, match_id, logged_by)
    select ids[i], tp.deck_id, coalesce(nullif(tp.deck_name, ''), 'Ingen lek vald'), r, array_length(ids, 1),
      left(array_to_string(array(select nm[k] from generate_subscripts(nm, 1) k where k <> i order by k), ', '), 300),
      left(format('%s, runda %s: %s%s', t.name, p_round + 1, outcome, res), 1000), mid, auth.uid()
    from (select 1) one left join public.lv_tour_players tp on tp.tour_id = p_tour and tp.user_id = ids[i]
    on conflict (owner, match_id) do nothing;
    get diagnostics cnt = row_count;
    added := added + cnt;
  end loop;
  return added;
end $fn$;

revoke all on function public.lv_tour_create(text, text, integer, integer, uuid[], uuid), public.lv_tour_respond(uuid, boolean, uuid),
  public.lv_tour_start(uuid, jsonb, integer), public.lv_tour_save(uuid, jsonb, integer, boolean, integer),
  public.lv_tour_delete(uuid), public.lv_tour_log(uuid, integer, integer) from public, anon;
grant execute on function public.lv_tour_create(text, text, integer, integer, uuid[], uuid), public.lv_tour_respond(uuid, boolean, uuid),
  public.lv_tour_start(uuid, jsonb, integer), public.lv_tour_save(uuid, jsonb, integer, boolean, integer),
  public.lv_tour_delete(uuid), public.lv_tour_log(uuid, integer, integer) to authenticated;

commit;
