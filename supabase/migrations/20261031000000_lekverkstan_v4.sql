-- Lekverkstan v4: utgåva/foil och datum i samlingen, bokning av kort i bytesbörsen.
-- Kräver v3. Rör inga familjetabeller.
begin;

-- ---------- samling: när kortet lades till och vilka utgåvor/foil man har ----------
alter table public.lv_collection
  add column added timestamptz not null default now(),
  add column prints jsonb not null default '[]'::jsonb
    check (jsonb_typeof(prints) = 'array' and pg_column_size(prints) < 20000);

-- ---------- bokningar: en användare ber om ett kort som en annan har till byte ----------
create table public.lv_bookings (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null default auth.uid() references auth.users (id) on delete cascade,
  seller uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 150),
  qty integer not null default 1 check (qty between 1 and 99),
  note text not null default '' check (char_length(note) <= 300),
  reply text not null default '' check (char_length(reply) <= 300),
  status text not null default 'requested' check (status in ('requested', 'accepted', 'declined', 'done', 'cancelled')),
  created timestamptz not null default now(),
  updated timestamptz not null default now(),
  check (requester <> seller)
);
create index lv_bookings_seller_idx on public.lv_bookings (seller, status);
create index lv_bookings_requester_idx on public.lv_bookings (requester, status);
alter table public.lv_bookings enable row level security;
revoke all on public.lv_bookings from anon, authenticated;
grant select, insert, delete on public.lv_bookings to authenticated;
grant update (status, reply, updated) on public.lv_bookings to authenticated;

-- bara de två inblandade ser bokningen
create policy "Egna bokningar syns" on public.lv_bookings for select to authenticated
  using (requester = (select auth.uid()) or seller = (select auth.uid()));
-- man kan bara boka åt sig själv, och bara kort som den andra har till byte
create policy "Boka kort till byte" on public.lv_bookings for insert to authenticated
  with check (
    requester = (select auth.uid()) and status = 'requested' and reply = ''
    and exists (select 1 from public.lv_collection c
                where c.owner = lv_bookings.seller and c.name = lv_bookings.name and c.for_trade > 0)
  );
-- säljaren svarar, den som bokat kan bara ångra sig
create policy "Svara på bokning" on public.lv_bookings for update to authenticated
  using (requester = (select auth.uid()) or seller = (select auth.uid()))
  with check (
    (seller = (select auth.uid()) and status in ('requested', 'accepted', 'declined', 'done'))
    or (requester = (select auth.uid()) and status = 'cancelled')
  );
create policy "Ta bort egen bokning" on public.lv_bookings for delete to authenticated
  using (requester = (select auth.uid()) or seller = (select auth.uid()));

commit;
