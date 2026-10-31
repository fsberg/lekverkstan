-- Lekverkstan v6: en lek kan markeras som ihopbyggd. Dess kort räknas då som upptagna i ägarens andra lekar.
alter table public.lv_decks add column if not exists built boolean not null default false;
