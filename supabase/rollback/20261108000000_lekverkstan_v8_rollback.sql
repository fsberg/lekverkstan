-- Ångrar Lekverkstan v8 (bytesförslag). Appen döljer då "Du kan ge" och valet i Inställningar igen.
begin;
drop function if exists public.lv_trade_wants();
alter table public.lv_profiles drop column if exists share_wants;
commit;
