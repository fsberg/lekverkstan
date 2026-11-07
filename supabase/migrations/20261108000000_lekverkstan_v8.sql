-- Lekverkstan v8: bytesförslag. Den som vill delar vad den saknar, men bara med den som har just de korten till byte.
-- Rör inga familjetabeller.

alter table public.lv_profiles add column share_wants boolean not null default false;

-- kort som andra saknar (i sina lekar eller på önskelistan) och som den som frågar har till byte.
-- Samlingar och önskelistor lämnar aldrig funktionen, bara namn och antal på matchande kort.
create function public.lv_trade_wants()
returns table (owner uuid, player text, name text, qty integer, src text)
language sql stable security definer set search_path = '' as $$
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
$$;
revoke all on function public.lv_trade_wants() from public, anon;
grant execute on function public.lv_trade_wants() to authenticated;
