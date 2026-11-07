-- Lekverkstan v9: när en bokning godkänns flyttas korten från säljarens samling till den som bokade.
-- Ångras eller nekas bokningen efteråt flyttas de tillbaka. Allt sker i databasen, så det blir rätt
-- även om den som bokade inte har appen öppen. Rör inga familjetabeller.

alter table public.lv_bookings add column moved boolean not null default false;

-- lägg till (d > 0) eller ta bort (d < 0) ex ur en samling. Utgåvor tas bort från de senast angivna, som i appen.
-- Bara för triggern nedan, ingen kan anropa den direkt.
create function public.lv_collection_add(o uuid, n text, d integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  cur public.lv_collection%rowtype;
  q integer; over integer; k integer; e jsonb; pr jsonb := '[]'::jsonb;
begin
  if d = 0 then return; end if;
  select * into cur from public.lv_collection c where c.owner = o and c.name = n for update;
  if not found then
    if d > 0 then insert into public.lv_collection (owner, name, qty) values (o, n, least(999, d)); end if;
    return;
  end if;
  q := least(999, cur.qty + d);
  if q <= 0 then
    delete from public.lv_collection c where c.owner = o and c.name = n;
    return;
  end if;
  over := (select coalesce(sum((x->>'qty')::integer), 0) from jsonb_array_elements(cur.prints) x) - q;
  if over > 0 then
    for e in select x from jsonb_array_elements(cur.prints) with ordinality t(x, i) order by i desc loop
      k := least(over, (e->>'qty')::integer);
      over := over - k;
      if (e->>'qty')::integer - k > 0 then
        pr := jsonb_build_array(jsonb_set(e, '{qty}', to_jsonb((e->>'qty')::integer - k))) || pr;
      end if;
    end loop;
  else
    pr := cur.prints;
  end if;
  update public.lv_collection c set
    qty = q,
    for_trade = greatest(0, least(cur.for_trade + least(d, 0), q)),
    prints = pr,
    added = case when d > 0 then now() else cur.added end
  where c.owner = o and c.name = n;
end $$;
revoke all on function public.lv_collection_add(uuid, text, integer) from public, anon, authenticated;

create function public.lv_booking_move()
returns trigger language plpgsql security definer set search_path = '' as $$
declare have integer; back integer;
begin
  if new.status in ('accepted', 'done') and not old.moved then
    select c.qty into have from public.lv_collection c where c.owner = new.seller and c.name = new.name;
    if coalesce(have, 0) < new.qty then
      raise exception 'Du har bara % ex av % i samlingen', coalesce(have, 0), new.name;
    end if;
    perform public.lv_collection_add(new.seller, new.name, -new.qty);
    perform public.lv_collection_add(new.requester, new.name, new.qty);
    new.moved := true;
  elsif new.status in ('requested', 'declined', 'cancelled') and old.moved then
    -- tillbaka, men aldrig fler än den som bokade fortfarande har
    select least(new.qty, coalesce(c.qty, 0)) into back from public.lv_collection c where c.owner = new.requester and c.name = new.name;
    back := coalesce(back, 0);
    perform public.lv_collection_add(new.requester, new.name, -back);
    perform public.lv_collection_add(new.seller, new.name, back);
    new.moved := false;
  end if;
  return new;
end $$;
revoke all on function public.lv_booking_move() from public, anon, authenticated;

create trigger lv_booking_move before update of status on public.lv_bookings
  for each row execute function public.lv_booking_move();
