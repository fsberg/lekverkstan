-- Lekverkstan: privata lekar och samlingar per användare, registrering med inbjudningskod,
-- gemensam cache för Alara-sökningar (skrivs bara av Edge Function med service role).
begin;

-- ---------- lekar ----------
create table public.decks (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  format text not null default 'commander' check (format in ('commander', 'modern')),
  cards jsonb not null default '[]'::jsonb check (jsonb_typeof(cards) = 'array' and pg_column_size(cards) < 200000),
  notes text not null default '' check (char_length(notes) <= 5000),
  created timestamptz not null default now(),
  updated timestamptz not null default now()
);
create index decks_owner_idx on public.decks (owner);

-- ---------- samling ----------
create table public.collection (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 150),
  qty integer not null check (qty between 1 and 999),
  primary key (owner, name)
);

-- ---------- inbjudningar (ingen åtkomst från webbläsaren) ----------
create table public.invites (
  code text primary key,
  note text not null default '',
  created_at timestamptz not null default now(),
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz
);

-- ---------- Alara-cache och anropsgräns (bara Edge Function) ----------
create table public.alara_cache (
  name text primary key,
  result jsonb not null,
  fetched_at timestamptz not null default now()
);
create table public.alara_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  minute timestamptz not null,
  calls integer not null default 0,
  primary key (user_id, minute)
);

-- ---------- rättigheter ----------
alter table public.decks enable row level security;
alter table public.collection enable row level security;
alter table public.invites enable row level security;
alter table public.alara_cache enable row level security;
alter table public.alara_usage enable row level security;

revoke all on public.decks, public.collection, public.invites, public.alara_cache, public.alara_usage from anon, authenticated;
grant select, insert, update, delete on public.decks, public.collection to authenticated;

create policy "Egna lekar" on public.decks for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "Egen samling" on public.collection for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- updated sätts av databasen, owner kan inte bytas
create function public.decks_touch() returns trigger language plpgsql set search_path = '' as $fn$
begin
  new.updated := now();
  if tg_op = 'UPDATE' then new.owner := old.owner; new.created := old.created; end if;
  return new;
end $fn$;
create trigger decks_touch before insert or update on public.decks for each row execute function public.decks_touch();

-- ---------- registrering kräver giltig, oanvänd kod ----------
create function public.require_invite() returns trigger language plpgsql security definer set search_path = '' as $fn$
declare c text := upper(trim(coalesce(new.raw_user_meta_data ->> 'invite', '')));
begin
  update public.invites set used_by = new.id, used_at = now()
   where code = c and used_by is null and used_at is null;
  if not found then
    raise exception 'Ogiltig eller redan använd inbjudningskod';
  end if;
  new.raw_user_meta_data := new.raw_user_meta_data - 'invite';
  return new;
end $fn$;
revoke execute on function public.require_invite() from public, anon, authenticated;
create trigger require_invite before insert on auth.users for each row execute function public.require_invite();

-- Skapa kod från SQL-editorn: select public.create_invite('Kalle');
create function public.create_invite(p_note text default '') returns text language plpgsql security definer set search_path = '' as $fn$
declare c text;
begin
  c := upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 4) || '-' || substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 4) || '-' || substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 4));
  insert into public.invites (code, note) values (c, coalesce(p_note, ''));
  return c;
end $fn$;
revoke execute on function public.create_invite(text) from public, anon, authenticated;

commit;
