-- Lekverkstan v11: grupper. Andras saker (publika lekar, bytesbörsen, namn, spelkvällar, topplista,
-- bytesförslag, bokningar, matchloggning) syns bara för den som delar minst en grupp med dem.
-- Den som inte är med i någon grupp ser bara sitt eget. Rör inga familjetabeller.
begin;

create table public.lv_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  owner uuid not null references auth.users (id) on delete cascade,
  code text not null unique,
  created timestamptz not null default now()
);
create table public.lv_group_members (
  group_id uuid not null references public.lv_groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index lv_group_members_user_idx on public.lv_group_members (user_id);

alter table public.lv_groups enable row level security;
alter table public.lv_group_members enable row level security;
revoke all on public.lv_groups, public.lv_group_members from anon, authenticated;
-- bara läsning direkt; allt som ändrar går via funktionerna nedan
grant select on public.lv_groups, public.lv_group_members to authenticated;

-- grupperna jag är med i (security definer så att policyerna inte slår i sig själva)
create function public.lv_my_groups() returns setof uuid
language sql stable security definer set search_path = '' as $fn$
  select m.group_id from public.lv_group_members m where m.user_id = auth.uid();
$fn$;
-- alla som delar en grupp med mig, och jag själv
create function public.lv_mates() returns setof uuid
language sql stable security definer set search_path = '' as $fn$
  select auth.uid() where auth.uid() is not null
  union
  select o.user_id from public.lv_group_members m join public.lv_group_members o on o.group_id = m.group_id
  where m.user_id = auth.uid();
$fn$;
revoke all on function public.lv_my_groups(), public.lv_mates() from public, anon;
grant execute on function public.lv_my_groups(), public.lv_mates() to authenticated;

create policy "Mina grupper syns" on public.lv_groups for select to authenticated
  using (id in (select public.lv_my_groups()));
create policy "Medlemmar i mina grupper syns" on public.lv_group_members for select to authenticated
  using (group_id in (select public.lv_my_groups()));

-- ---------- funktioner för grupper ----------
create function public.lv_group_code() returns text
language sql volatile set search_path = '' as $fn$
  select upper(substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 4) || '-' || substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 4));
$fn$;
revoke all on function public.lv_group_code() from public, anon, authenticated;

create function public.lv_group_create(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); g uuid;
begin
  if me is null then raise exception 'Inte inloggad'; end if;
  if (select count(*) from public.lv_groups where owner = me) >= 10 then raise exception 'Du kan ha högst 10 egna grupper'; end if;
  insert into public.lv_groups (name, owner, code) values (left(btrim(p_name), 40), me, public.lv_group_code()) returning id into g;
  insert into public.lv_group_members (group_id, user_id) values (g, me);
  return g;
end $fn$;

create function public.lv_group_join(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); g uuid;
begin
  if me is null then raise exception 'Inte inloggad'; end if;
  select id into g from public.lv_groups where code = upper(btrim(coalesce(p_code, '')));
  if g is null then raise exception 'Ingen grupp har den koden'; end if;
  if (select count(*) from public.lv_group_members where group_id = g) >= 50 then raise exception 'Gruppen är full'; end if;
  insert into public.lv_group_members (group_id, user_id) values (g, me) on conflict do nothing;
  return g;
end $fn$;

-- lämna en grupp. Lämnar ägaren tar den som varit med längst över; är ingen kvar tas gruppen bort.
create function public.lv_group_leave(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $fn$
declare me uuid := auth.uid(); nxt uuid;
begin
  delete from public.lv_group_members where group_id = p_group and user_id = me;
  if not found then return; end if;
  if exists (select 1 from public.lv_groups where id = p_group and owner = me) then
    select user_id into nxt from public.lv_group_members where group_id = p_group order by joined limit 1;
    if nxt is null then delete from public.lv_groups where id = p_group;
    else update public.lv_groups set owner = nxt where id = p_group; end if;
  end if;
end $fn$;

-- bara ägaren: ta bort en medlem, byta namn, ny kod (den gamla slutar gälla), radera gruppen
create function public.lv_group_kick(p_group uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  if not exists (select 1 from public.lv_groups where id = p_group and owner = auth.uid()) then raise exception 'Bara gruppens ägare kan ta bort medlemmar'; end if;
  if p_user = auth.uid() then raise exception 'Använd Lämna gruppen'; end if;
  delete from public.lv_group_members where group_id = p_group and user_id = p_user;
end $fn$;

create function public.lv_group_update(p_group uuid, p_name text, p_new_code boolean) returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  if not exists (select 1 from public.lv_groups where id = p_group and owner = auth.uid()) then raise exception 'Bara gruppens ägare kan ändra gruppen'; end if;
  update public.lv_groups set
    name = coalesce(nullif(left(btrim(coalesce(p_name, '')), 40), ''), name),
    code = case when p_new_code then public.lv_group_code() else code end
  where id = p_group;
end $fn$;

create function public.lv_group_delete(p_group uuid) returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  if not exists (select 1 from public.lv_groups where id = p_group and owner = auth.uid()) then raise exception 'Bara gruppens ägare kan radera gruppen'; end if;
  delete from public.lv_groups where id = p_group;
end $fn$;

revoke all on function public.lv_group_create(text), public.lv_group_join(text), public.lv_group_leave(uuid),
  public.lv_group_kick(uuid, uuid), public.lv_group_update(uuid, text, boolean), public.lv_group_delete(uuid) from public, anon;
grant execute on function public.lv_group_create(text), public.lv_group_join(text), public.lv_group_leave(uuid),
  public.lv_group_kick(uuid, uuid), public.lv_group_update(uuid, text, boolean), public.lv_group_delete(uuid) to authenticated;

-- ---------- det som delas syns bara inom grupperna ----------
drop policy "Publika lekar syns" on public.lv_decks;
create policy "Publika lekar syns i gruppen" on public.lv_decks for select to authenticated
  using (public and owner in (select public.lv_mates()));

drop policy "Bytesbörsen syns" on public.lv_collection;
create policy "Bytesbörsen syns i gruppen" on public.lv_collection for select to authenticated
  using (for_trade > 0 and owner in (select public.lv_mates()));

drop policy "Namn syns för inloggade" on public.lv_profiles;
create policy "Namn syns i gruppen" on public.lv_profiles for select to authenticated
  using (user_id in (select public.lv_mates()));

drop policy "Spelkvällar syns för inloggade" on public.lv_events;
create policy "Spelkvällar syns i gruppen" on public.lv_events for select to authenticated
  using (owner in (select public.lv_mates()));

drop policy "Svar syns för inloggade" on public.lv_event_replies;
create policy "Svar syns i gruppen" on public.lv_event_replies for select to authenticated
  using (user_id in (select public.lv_mates())
    and exists (select 1 from public.lv_events e where e.id = lv_event_replies.event and e.owner in (select public.lv_mates())));
drop policy "Eget svar skapas" on public.lv_event_replies;
create policy "Eget svar skapas" on public.lv_event_replies for insert to authenticated
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.lv_events e where e.id = lv_event_replies.event and e.owner in (select public.lv_mates())));

drop policy "Boka kort till byte" on public.lv_bookings;
create policy "Boka kort till byte" on public.lv_bookings for insert to authenticated
  with check (requester = (select auth.uid()) and status = 'requested' and reply = ''
    and seller in (select public.lv_mates())
    and exists (select 1 from public.lv_collection c where c.owner = lv_bookings.seller and c.name = lv_bookings.name and c.for_trade > 0));

create or replace function public.lv_leaderboard()
returns table (player text, deck_name text, played_on date, result text, players integer, opponents text)
language sql stable security definer set search_path = '' as $fn$
  select p.display_name, g.deck_name, g.played_on, g.result, g.players, g.opponents
  from public.lv_games g
  join public.lv_profiles p on p.user_id = g.owner
  where p.share_games and auth.uid() is not null and g.owner in (select public.lv_mates())
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
    where me.id is not null and p.share_wants and p.user_id <> me.id and p.user_id in (select public.lv_mates())
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

-- matcher kan bara loggas hos spelare man delar en grupp med
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
  if exists (select 1 from unnest(p_players) x where x not in (select public.lv_mates())) then raise exception 'Alla spelare måste vara med i en av dina grupper'; end if;
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

-- ---------- de som redan använder Lekverkstan hamnar i en gemensam grupp ----------
-- så att inget ändras för dem. Ägare blir det första kontot (appens skapare); gruppen går att byta namn på.
with g as (
  insert into public.lv_groups (name, owner, code)
  select 'Lekverkstan', u.id, public.lv_group_code() from (select id from auth.users order by created_at limit 1) u
  returning id
)
insert into public.lv_group_members (group_id, user_id)
select g.id, x.id from g cross join (
  select owner as id from public.lv_decks union select owner from public.lv_collection
  union select user_id from public.lv_profiles union select owner from public.lv_games
  union select used_by from public.lv_invites where used_by is not null
) x where x.id is not null;

commit;
