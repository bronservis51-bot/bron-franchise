-- 0014 Каталог в стиле магазина плёнок (решение владельца 13.10.2026): артикул, подпись («Лист на 6 телефонов»),
-- описание макета для изображения товара и необязательная ссылка на фото.

alter table public.catalog_item
  add column article_no int,
  add column subtitle text,
  add column visual jsonb not null default '{}'::jsonb,
  add column image_url text,
  add column sort int not null default 100;

-- Новая форма результата: удалить и создать заново (с перерегистрацией в реестре клиентских команд)
delete from app_private.client_command where fn = 'public.catalog_for_location(uuid)'::regprocedure;
drop function public.catalog_for_location(uuid);

create function public.catalog_for_location(p_location uuid)
returns table (item_id uuid, sku text, article_no int, name text, category text, subtitle text, description text, unit text,
  pack_multiple numeric, min_qty numeric, lead_time_days int, price_minor bigint, currency text, available_qty numeric,
  stock_source text, stock_refreshed_at timestamptz, visual jsonb, image_url text)
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
#variable_conflict use_column
declare l public.location; v_list uuid; v_cur text;
begin
  perform app_private.require_user();
  select * into l from public.location where id = p_location;
  if not found or not app_private.in_scope(l.partner_id, l.id) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  perform app_private.require_perm('catalog.read', l.partner_id, l.id);
  v_list := app_private.price_list_for(l.id, case when l.kind = 'own' then 'supply_request' else 'partner_order' end);
  select currency into v_cur from public.price_list where id = v_list;
  return query
    select i.id, i.sku, i.article_no, i.name, i.category, i.subtitle, i.description, i.unit, i.pack_multiple, i.min_qty, i.lead_time_days,
      app_private.current_price(v_list, i.id), v_cur,
      (select sum(s.available_qty) from public.stock_projection s where s.item_id = i.id),
      (select max(s.source) from public.stock_projection s where s.item_id = i.id),
      (select max(s.refreshed_at) from public.stock_projection s where s.item_id = i.id),
      i.visual, i.image_url
    from public.catalog_item i
    where i.active and (i.direction_id is null or i.direction_id = l.direction_id)
      and app_private.current_price(v_list, i.id) is not null
    order by i.sort, i.article_no nulls last, i.name;
end $$;

insert into app_private.client_command(fn) values ('public.catalog_for_location(uuid)');
select app_private.apply_grants();
