-- Lekverkstan v3: önskelista med lagerbevakning och utlånade kort. Båda är privata.
-- Rör inga familjetabeller.
begin;

-- ---------- önskelista (appen kollar Alara högst en gång per dygn och kort) ----------
create table public.lv_wishlist (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 150),
  qty integer not null default 1 check (qty between 1 and 99),
  max_price numeric(10, 2) check (max_price >= 0),
  last_price numeric(10, 2),
  in_stock boolean,
  checked_at timestamptz,
  alert boolean not null default false,
  note text not null default '' check (char_length(note) <= 200),
  created timestamptz not null default now(),
  primary key (owner, name)
);
alter table public.lv_wishlist enable row level security;
revoke all on public.lv_wishlist from anon, authenticated;
grant select, insert, update, delete on public.lv_wishlist to authenticated;
create policy "Egen önskelista" on public.lv_wishlist for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- ---------- utlånade kort ----------
create table public.lv_loans (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 150),
  qty integer not null default 1 check (qty between 1 and 99),
  borrower text not null check (char_length(btrim(borrower)) between 1 and 60),
  lent_on date not null default current_date,
  note text not null default '' check (char_length(note) <= 200),
  created timestamptz not null default now()
);
create index lv_loans_owner_idx on public.lv_loans (owner, lent_on desc);
alter table public.lv_loans enable row level security;
revoke all on public.lv_loans from anon, authenticated;
grant select, insert, update, delete on public.lv_loans to authenticated;
create policy "Egna lån" on public.lv_loans for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

commit;
