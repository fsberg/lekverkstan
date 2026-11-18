-- Ångrar Lekverkstan v12 och återställer v11. Konton som skapats med gruppkod finns kvar och är kvar i gruppen.
-- Turneringsmatcher som redan loggats behålls i spelloggen men tappar sin koppling (match_id blir tom).
begin;

drop trigger if exists lv_signup_group on auth.users;
drop function if exists public.lv_signup_group();

create or replace function public.lv_require_invite() returns trigger language plpgsql security definer set search_path = '' as $fn$
declare c text := upper(trim(coalesce(new.raw_user_meta_data ->> 'invite', '')));
begin
  update public.lv_invites set used_by = new.id, used_at = now()
   where code = c and used_by is null and used_at is null;
  if not found then
    raise exception 'Ogiltig eller redan använd inbjudningskod';
  end if;
  new.raw_user_meta_data := new.raw_user_meta_data - 'invite';
  return new;
end $fn$;

drop function if exists public.lv_group_update(uuid, text, boolean, boolean);
create function public.lv_group_update(p_group uuid, p_name text, p_new_code boolean) returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  if not exists (select 1 from public.lv_groups where id = p_group and owner = auth.uid()) then raise exception 'Bara gruppens ägare kan ändra gruppen'; end if;
  update public.lv_groups set
    name = coalesce(nullif(left(btrim(coalesce(p_name, '')), 40), ''), name),
    code = case when p_new_code then public.lv_group_code() else code end
  where id = p_group;
end $fn$;
revoke all on function public.lv_group_update(uuid, text, boolean) from public, anon;
grant execute on function public.lv_group_update(uuid, text, boolean) to authenticated;
alter table public.lv_groups drop column if exists signup;

update public.lv_games set match_id = null where match_id like 'tur-%';
alter table public.lv_games drop constraint if exists lv_games_match_id_check;
alter table public.lv_games add constraint lv_games_match_id_check check (match_id ~ '^liv-[0-9]{1,16}$');

drop function if exists public.lv_log_match(text, uuid[], integer, integer, text);
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
revoke all on function public.lv_log_match(text, uuid[], integer, integer) from public, anon;
grant execute on function public.lv_log_match(text, uuid[], integer, integer) to authenticated;

commit;
