-- Ångrar Lekverkstan v11 (grupper). Allt delat syns åter för alla inloggade, precis som i v10.
-- Grupperna och medlemskapen raderas.
begin;

drop policy if exists "Publika lekar syns i gruppen" on public.lv_decks;
create policy "Publika lekar syns" on public.lv_decks for select to authenticated using (public);

drop policy if exists "Bytesbörsen syns i gruppen" on public.lv_collection;
create policy "Bytesbörsen syns" on public.lv_collection for select to authenticated using (for_trade > 0);

drop policy if exists "Namn syns i gruppen" on public.lv_profiles;
create policy "Namn syns för inloggade" on public.lv_profiles for select to authenticated using (true);

drop policy if exists "Spelkvällar syns i gruppen" on public.lv_events;
create policy "Spelkvällar syns för inloggade" on public.lv_events for select to authenticated using (true);

drop policy if exists "Svar syns i gruppen" on public.lv_event_replies;
create policy "Svar syns för inloggade" on public.lv_event_replies for select to authenticated using (true);
drop policy if exists "Eget svar skapas" on public.lv_event_replies;
create policy "Eget svar skapas" on public.lv_event_replies for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "Boka kort till byte" on public.lv_bookings;
create policy "Boka kort till byte" on public.lv_bookings for insert to authenticated
  with check (requester = (select auth.uid()) and status = 'requested' and reply = ''
    and exists (select 1 from public.lv_collection c where c.owner = lv_bookings.seller and c.name = lv_bookings.name and c.for_trade > 0));

create or replace function public.lv_leaderboard()
returns table (player text, deck_name text, played_on date, result text, players integer, opponents text)
language sql stable security definer set search_path = '' as $fn$
  select p.display_name, g.deck_name, g.played_on, g.result, g.players, g.opponents
  from public.lv_games g
  join public.lv_profiles p on p.user_id = g.owner
  where p.share_games and auth.uid() is not null
  order by g.played_on desc, g.created desc
  limit 5000;
$fn$;

create or replace function public.lv_trade_wants()
returns table (owner uuid, player text, name text, qty integer, src text)
language sql stable security definer set search_path = '' as $fn$
  with me as (select auth.uid() as id),
  mine as (
    select lower(c.name) as lname from public.lv_collection c, me where c.owner = me.id and c.for_trade > 0
  ),
  friends as (
    select p.user_id, p.display_name from public.lv_profiles p, me
    where me.id is not null and p.share_wants and p.user_id <> me.id
  ),
  need as (
    select d.owner as o, e->>'name' as n, max((e->>'qty')::integer) as q
    from public.lv_decks d
    join friends f on f.user_id = d.owner
    cross join lateral jsonb_array_elements(d.cards) e
    where coalesce(e->>'board', 'main') <> 'maybe' and (e->>'qty') ~ '^[0-9]{1,3}$' and lower(e->>'name') in (select lname from mine)
    group by d.owner, e->>'name'
  ),
  wanted as (
    select n.o, n.n, n.q - coalesce(c.qty, 0) as q, 'lek' as s
    from need n left join public.lv_collection c on c.owner = n.o and c.name = n.n
    where n.q > coalesce(c.qty, 0)
    union all
    select w.owner, w.name, w.qty, 'önskelista'
    from public.lv_wishlist w join friends f on f.user_id = w.owner
    where lower(w.name) in (select lname from mine)
  )
  select x.o, f.display_name, x.n, max(x.q), string_agg(distinct x.s, ',')
  from wanted x join friends f on f.user_id = x.o
  group by x.o, f.display_name, x.n
  limit 2000;
$fn$;

create or replace function public.lv_log_match(p_match text, p_players uuid[], p_winner integer, p_minutes integer)
returns integer
language plpgsql security definer set search_path = '' as $fn$
declare
  me uuid := auth.uid();
  n integer := coalesce(array_length(p_players, 1), 0);
  names text[];
  by_name text;
  added integer := 0;
  i integer;
  cnt integer;
begin
  if me is null then raise exception 'Inte inloggad'; end if;
  if p_match is null or p_match !~ '^liv-[0-9]{1,16}$' then raise exception 'Ogiltig match'; end if;
  if n < 2 or n > 6 then raise exception 'Fel antal spelare'; end if;
  if array_position(p_players, null) is not null or (select count(distinct x) from unnest(p_players) x) <> n then raise exception 'Samma spelare två gånger'; end if;
  if not (me = any (p_players)) then raise exception 'Du måste själv vara med i matchen'; end if;
  if p_winner is not null and (p_winner < 0 or p_winner >= n) then raise exception 'Ogiltig vinnare'; end if;
  select array_agg(coalesce(nullif(btrim(p.display_name), ''), 'Okänd') order by u.ord) into names
    from unnest(p_players) with ordinality u(id, ord) join public.lv_profiles p on p.user_id = u.id;
  if coalesce(array_length(names, 1), 0) <> n then raise exception 'Alla spelare måste vara användare'; end if;
  by_name := names[array_position(p_players, me)];
  for i in 1 .. n loop
    continue when p_players[i] = me;
    insert into public.lv_games (owner, deck_name, result, players, opponents, notes, match_id, logged_by)
    values (
      p_players[i], 'Ingen lek vald',
      case when p_winner is null then 'draw' when p_winner = i - 1 then 'win' else 'loss' end,
      n,
      left(array_to_string(array(select names[k] from generate_subscripts(names, 1) k where k <> i order by k), ', '), 300),
      left(format('Livräknare: %s, %s min · loggad av %s',
        case when p_winner is null then 'oavgjort' else names[p_winner + 1] || ' vann' end,
        greatest(0, least(coalesce(p_minutes, 0), 1440)), by_name), 1000),
      p_match, me)
    on conflict (owner, match_id) do nothing;
    get diagnostics cnt = row_count;
    added := added + cnt;
  end loop;
  return added;
end $fn$;

drop function if exists public.lv_group_create(text);
drop function if exists public.lv_group_join(text);
drop function if exists public.lv_group_leave(uuid);
drop function if exists public.lv_group_kick(uuid, uuid);
drop function if exists public.lv_group_update(uuid, text, boolean);
drop function if exists public.lv_group_delete(uuid);
drop function if exists public.lv_group_code();
drop table if exists public.lv_group_members;
drop table if exists public.lv_groups;
drop function if exists public.lv_mates();
drop function if exists public.lv_my_groups();

commit;
