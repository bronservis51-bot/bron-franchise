-- 0024 Решения владельца 14.10.2026:
--   • обязательное ознакомление — только тем, кого статья касается (ack_roles), а не всем, кто может её читать;
--   • «Выручка сети» для руководства: выручка всех точек за месяц с разбивкой по дням, для фильтров по владению, стране, городу, франчайзи.

alter table public.article add column ack_roles text[]; -- null = все читатели статьи; иначе обязательное ознакомление только этим ролям

create or replace function app_private.kb_audience_users(a public.article) returns setof uuid
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select distinct x.user_id from public.role_assignment x
  join public.app_user u on u.id = x.user_id and u.status = 'active'
  join public.role r on r.code = x.role
  join public.role_permission rp on rp.role = x.role and rp.permission = 'kb.read'
  where x.revoked_at is null and x.valid_from <= now() and (x.valid_to is null or x.valid_to > now())
    and (a.audience = 'all' or r.kind = 'staff')
    and (a.audience_roles is null or x.role = any(a.audience_roles))
    and (a.ack_roles is null or x.role = any(a.ack_roles))
$$;

-- Задать, кому статья обязательна (редактор / публикующий)
create function public.article_set_ack_roles(p_article uuid, p_roles text[]) returns public.article
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article;
begin
  perform app_private.require_user();
  if not (app_private.has_perm_anywhere('kb.publish') or app_private.has_perm_anywhere('kb.edit')) then
    perform app_private.fail('forbidden', 'Нет права менять статью');
  end if;
  if p_roles is not null and exists (select 1 from unnest(p_roles) r where not exists (select 1 from public.role where code = r)) then
    perform app_private.fail('validation', 'Неизвестная роль', 'roles');
  end if;
  update public.article set ack_roles = nullif(p_roles, '{}'), updated_at = now(), revision = revision + 1 where id = p_article returning * into a;
  if not found then perform app_private.fail('not-found', 'Статья не найдена'); end if;
  -- Снять незавершённые ознакомления у тех, кого статья больше не касается
  delete from public.ack_assignment k where k.article_id = a.id and k.completed_at is null
    and not exists (select 1 from app_private.kb_audience_users(a) u where u = k.user_id);
  perform app_private.audit('kb.ack_roles', 'article', a.id, null, jsonb_build_object('ack_roles', a.ack_roles));
  return a;
end $$;

-- Действующие статьи: стандарт оклейки — тем, кто оклеивает; регламент отчёта — франчайзи
update public.article set ack_roles = '{location_staff,partner_staff,location_manager,partner_owner}' where slug = 'standart-okleyki';
update public.article set ack_roles = '{partner_owner}' where slug = 'reglament-otcheta';
delete from public.ack_assignment k using public.article a
where a.id = k.article_id and a.ack_roles is not null and k.completed_at is null
  and not exists (select 1 from app_private.kb_audience_users(a) u where u = k.user_id);
delete from public.notification n where n.kind = 'kb.ack' and n.read_at is null
  and not exists (select 1 from public.ack_assignment k where k.article_id = n.entity_id and k.user_id = n.user_id);

------------------------------------------------------------------------------
-- Выручка сети за месяц: по каждой точке, с днями — фильтры и графики строятся в интерфейсе
------------------------------------------------------------------------------
create function public.network_sales(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_from date := date_trunc('month', coalesce(p_month, current_date))::date;
  v_to date := (date_trunc('month', coalesce(p_month, current_date)) + interval '1 month' - interval '1 day')::date;
  v_prev date := (date_trunc('month', coalesce(p_month, current_date)) - interval '1 month')::date;
begin
  perform app_private.require_user();
  if not (app_private.is_staff() and app_private.has_perm_anywhere('sales.read')) then
    perform app_private.fail('forbidden', 'Выручка сети доступна сотрудникам компании');
  end if;
  return jsonb_build_object('month', v_from, 'days_in_month', v_to - v_from + 1, 'today', current_date, 'locations', coalesce((
    select jsonb_agg(x order by x.revenue_minor desc, x.name) from (
      select l.id, l.code, l.name, l.kind, l.status, l.country, c.name as country_name, l.city, l.currency, l.opened_on,
        p.id as partner_id, p.name as partner_name,
        coalesce(m.revenue, 0)::bigint as revenue_minor, coalesce(m.returns, 0)::bigint as returns_minor, coalesce(m.services, 0)::int as services,
        coalesce(m.card, 0)::bigint as card_minor, coalesce(m.card_known, 0)::bigint as card_known_minor, coalesce(m.earn, 0)::bigint as earnings_minor,
        coalesce(m.days, 0)::int as days_with_data,
        (select coalesce(sum(s.revenue_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day >= v_prev and s.day < v_from)::bigint as prev_revenue_minor,
        -- прошлый месяц на то же число — честное сравнение незаконченного месяца
        (select coalesce(sum(s.revenue_minor), 0) from public.daily_sale s where s.location_id = l.id and s.day >= v_prev
          and s.day <= least(v_prev + (least(v_to, (now() at time zone l.timezone)::date) - v_from), v_from - 1))::bigint as prev_to_date_minor,
        case when l.status = 'active' then (select count(*) from generate_series(greatest(v_from, coalesce(l.opened_on, v_from)),
            least(v_to, (now() at time zone l.timezone)::date - 1), interval '1 day') d
          where not app_private.sales_day_covered(l.id, d::date))::int else 0 end as missing_days,
        coalesce((select jsonb_agg(jsonb_build_array(g.day, g.rev) order by g.day) from (
          select s.day, sum(s.revenue_minor)::bigint as rev from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to group by s.day) g), '[]'::jsonb) as daily
      from public.location l
      join public.country c on c.code = l.country
      left join public.partner p on p.id = l.partner_id
      left join lateral (select sum(s.revenue_minor) as revenue, sum(s.returns_minor) as returns, sum(s.services_count) as services,
          sum(s.card_minor) filter (where s.card_minor is not null) as card, sum(s.revenue_minor) filter (where s.card_minor is not null) as card_known,
          sum(round((s.revenue_minor - s.returns_minor)::numeric * app_private.commission_rate(s.location_id, s.day, s.employee_id) / 10000)) as earn,
          count(distinct s.day) as days
        from public.daily_sale s where s.location_id = l.id and s.day between v_from and v_to) m on true
      where l.status <> 'closed' and app_private.has_perm('sales.read', l.partner_id, l.id)
    ) x), '[]'::jsonb));
end $$;

insert into app_private.client_command(fn) values ('public.network_sales(date)'), ('public.article_set_ack_roles(uuid, text[])');
select app_private.apply_grants();
