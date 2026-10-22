-- 0013
-- Заказ материалов (плёнки, расходники) через МойСклад: у каждого франчайзи своя ссылка контрагента.
-- Ссылку вставляет менеджер в карточке франчайзи; франчайзи видит кнопку «Заказать материалы», которая открывает МойСклад.
alter table public.partner add column order_url text
  check (order_url is null or (order_url ~ '^https://[^[:space:]]+$' and length(order_url) <= 1000));

create function public.partner_order_url_set(p_partner uuid, p_url text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_url text := nullif(trim(p_url), ''); v_old text;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  select order_url into v_old from public.partner where id = p_partner;
  if not found then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  if v_url is not null and (v_url !~ '^https://[^[:space:]]+$' or length(v_url) > 1000) then
    perform app_private.fail('validation', 'Вставьте полную ссылку, которая начинается с https://', 'url');
  end if;
  update public.partner set order_url = v_url, updated_at = now() where id = p_partner;
  perform app_private.audit('partner.order_url', 'partner', p_partner, p_partner, jsonb_build_object('from', v_old, 'to', v_url));
end $$;

-- Ссылка для заказа у франчайзи текущего пользователя (null — менеджер ещё не добавил).
create function public.order_link() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid;
begin
  perform app_private.require_user();
  select scope_id into v_partner from app_private.active_assignments() a where a.role = 'franchisee' limit 1;
  if v_partner is null then perform app_private.fail('forbidden', 'Заказ материалов доступен франчайзи'); end if;
  return (select jsonb_build_object('url', order_url) from public.partner where id = v_partner);
end $$;

insert into app_private.client_command(fn) values ('public.partner_order_url_set(uuid, text)'), ('public.order_link()');
select app_private.apply_grants();
