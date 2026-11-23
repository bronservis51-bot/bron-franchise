-- An address is personal. A fresh opaque identifier represents each assignment,
-- including a return to an earlier address. The client never needs to store the address.
alter table public.partner add column order_url_assignment_id uuid;

update public.partner set order_url_assignment_id = gen_random_uuid() where order_url is not null;

create function app_private.set_order_url_assignment() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.order_url is null then
    new.order_url_assignment_id := null;
  elsif tg_op = 'INSERT' then
    new.order_url_assignment_id := coalesce(new.order_url_assignment_id, gen_random_uuid());
  elsif new.order_url is distinct from old.order_url then
    new.order_url_assignment_id := gen_random_uuid();
  end if;
  return new;
end $$;

revoke all on function app_private.set_order_url_assignment() from public, anon, authenticated;
create trigger set_order_url_assignment
before insert or update of order_url on public.partner
for each row execute function app_private.set_order_url_assignment();

create or replace function public.order_link() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare ids uuid[];
begin
  perform app_private.require_user();
  select array_agg(distinct a.scope_id) into ids from app_private.active_assignments() a
    where a.scope_type = 'partner' and app_private.has_perm('procurement.order', a.scope_id);
  if coalesce(cardinality(ids), 0) = 0 then perform app_private.fail('forbidden', 'Нет доступа к заказу материалов'); end if;
  if cardinality(ids) <> 1 then perform app_private.fail('validation', 'Нужно выбрать франчайзи: к аккаунту привязано несколько компаний'); end if;
  return (select jsonb_build_object('url', order_url, 'assignment_id', order_url_assignment_id) from public.partner where id = ids[1]);
end $$;
