-- Lekverkstan v10: livräknaren loggar matchen hos alla användare som spelade.
-- Rör inga familjetabeller.

-- match_id knyter ihop samma match hos alla spelare, så att den aldrig loggas två gånger hos någon
alter table public.lv_games add column match_id text check (match_id ~ '^liv-[0-9]{1,16}$');
alter table public.lv_games add column logged_by uuid references auth.users (id) on delete set null;
alter table public.lv_games add constraint lv_games_owner_match_key unique (owner, match_id);

-- loggar en match från livräknaren hos de andra spelarna (den som anropar loggar sin egen rad själv, med sin lek).
-- Den som anropar måste själv vara med i matchen. Namnen tas från lv_profiles, inte från klienten.
-- Den som fått en match loggad kan ta bort den eller välja lek, eftersom raden är dennes egen.
create function public.lv_log_match(p_match text, p_players uuid[], p_winner integer, p_minutes integer)
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
revoke all on function public.lv_log_match(text, uuid[], integer, integer) from public, anon;
grant execute on function public.lv_log_match(text, uuid[], integer, integer) to authenticated;
