-- Tar bort markeringen ihopbyggd. Appen döljer valet när kolumnen saknas.
alter table public.lv_decks drop column if exists built;
