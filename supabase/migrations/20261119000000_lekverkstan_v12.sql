-- Lekverkstan v12: gruppkoden räcker för att skapa konto (och ger gruppen direkt), ägaren kan stänga av det,
-- och turneringsmatcher (match_id 'tur-…') kan loggas hos båda spelarna. Rör inga familjetabeller.
-- Kräver v11.
begin;

-- ---------- gruppkod som inbjudan ----------
alter table public.lv_groups add column signup boolean not null default true;

-- registrering: en engångskod från lv_invites som förut, eller koden till en grupp som tar emot nya konton
create or replace function public.lv_require_invite() returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  c text := upper(trim(coalesce(meta ->> 'invite', '')));
  g uuid;
begin
  update public.lv_invites set used_by = new.id, used_at = now()
   where code = c and used_by is null and used_at is null;
  if found then
    new.raw_user_meta_data := meta - 'invite' - 'lv_group';
    return new;
  end if;
  select id into g from public.lv_groups where code = c and signup;
  if g is null or (select count(*) from public.lv_group_members where group_id = g) >= 50 then
    raise exception 'Ogiltig eller redan använd inbjudningskod';
  end if;
  -- kontot finns inte än; medlemskapet läggs in av lv_signup_group efter insert
  new.raw_user_meta_data := (meta - 'invite') || jsonb_build_object('lv_group', g::text);
  return new;
end $fn$;

create function public.lv_signup_group() returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  if coalesce(new.raw_user_meta_data ->> 'lv_group', '') ~ '^[0-9a-f-]{36}$' then
    insert into public.lv_group_members (group_id, user_id)
    select id, new.id from public.lv_groups where id = (new.raw_user_meta_data ->> 'lv_group')::uuid
    on conflict do nothing;
  end if;
  return null;
end $fn$;
revoke execute on function public.lv_signup_group() from public, anon, authenticated;
create trigger lv_signup_group after insert on auth.users for each row execute function public.lv_signup_group();

-- ägaren kan stänga av att koden skapar nya konton (befintliga kan fortfarande gå med)
drop function public.lv_group_update(uuid, text, boolean);
create function public.lv_group_update(p_group uuid, p_name text, p_new_code boolean, p_signup boolean default null) returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  if not exists (select 1 from public.lv_groups where id = p_group and owner = auth.uid()) then raise exception 'Bara gruppens ägare kan ändra gruppen'; end if;
  update public.lv_groups set
    name = coalesce(nullif(left(btrim(coalesce(p_name, '')), 40), ''), name),
    code = case when p_new_code then public.lv_group_code() else code end,
    signup = coalesce(p_signup, signup)
  where id = p_group;
end $fn$;
revoke all on function public.lv_group_update(uuid, text, boolean, boolean) from public, anon;
grant execute on function public.lv_group_update(uuid, text, boolean, boolean) to authenticated;

-- ---------- turneringsmatcher ----------
do $x$ declare n text;
begin
  select conname into n from pg_constraint
   where conrelid = 'public.lv_games'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%match_id%';
  if n is not null then execute format('alter table public.lv_games drop constraint %I', n); end if;
end $x$;
alter table public.lv_games add constraint lv_games_match_id_check check (match_id ~ '^(liv|tur)-[0-9]{1,16}$');

drop function public.lv_log_match(text, uuid[], integer, integer);
create function public.lv_log_match(p_match text, p_players uuid[], p_winner integer, p_minutes integer, p_score text default null)
returns integer
language plpgsql security definer set search_path = '' as $fn$
declare
  me uuid := auth.uid();
  n integer := coalesce(array_length(p_players, 1), 0);
  tour boolean := p_match like 'tur-%';
  names text[];
  by_name text;
  added integer := 0;
  i integer;
  cnt integer;
  sc text := case when p_score ~ '^[0-3]-[0-3](-[0-3])?$' then replace(p_score, '-', '–') end;
begin
  if me is null then raise exception 'Inte inloggad'; end if;
  if p_match is null or p_match !~ '^(liv|tur)-[0-9]{1,16}$' then raise exception 'Ogiltig match'; end if;
  if n < 2 or n > 6 or (tour and n <> 2) then raise exception 'Fel antal spelare'; end if;
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
      left(case when tour then
          format('Turnering: %s%s · loggad av %s',
            case when p_winner is null then 'oavgjort' else names[p_winner + 1] || ' vann' end,
            case when sc is null then '' else ' ' || sc end, by_name)
        else format('Livräknare: %s, %s min · loggad av %s',
            case when p_winner is null then 'oavgjort' else names[p_winner + 1] || ' vann' end,
            greatest(0, least(coalesce(p_minutes, 0), 1440)), by_name) end, 1000),
      p_match, me)
    on conflict (owner, match_id) do nothing;
    get diagnostics cnt = row_count;
    added := added + cnt;
  end loop;
  return added;
end $fn$;
revoke all on function public.lv_log_match(text, uuid[], integer, integer, text) from public, anon;
grant execute on function public.lv_log_match(text, uuid[], integer, integer, text) to authenticated;

commit;
