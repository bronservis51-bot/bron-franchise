-- 0010
-- Начало учёта роялти у франчайзи. Выручку за прошлые месяцы можно перенести из таблиц для истории и рейтинга,
-- но роялти (и долг) считаются только с этого месяца: прошлые расчёты велись вне приложения.
-- Неоплаченное до начала учёта вносится вручную как «прошлый долг».
alter table public.partner add column royalty_from date check (royalty_from = date_trunc('month', royalty_from)::date);

create or replace function app_private.royalty_ledger(p_partner uuid)
returns table (month date, revenue_minor bigint, rate_bp int, accrued_minor bigint, manual_minor bigint, paid_minor bigint,
  debt_minor bigint, is_open boolean)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with start as (
    select royalty_from as f from public.partner where id = p_partner
  ), months as (
    select date_trunc('month', day)::date as m from public.daily_revenue, start
      where partner_id = p_partner and (start.f is null or day >= start.f)
    union select month from public.royalty_manual where partner_id = p_partner
    union select month from public.royalty_payment where partner_id = p_partner
  ), rev as (
    select date_trunc('month', day)::date as m, sum(total_minor)::bigint as v from public.daily_revenue, start
      where partner_id = p_partner and (start.f is null or day >= start.f) group by 1
  ), x as (
    select m.m, coalesce(rev.v, 0) as revenue, app_private.rate_bp(p_partner, m.m) as bp,
      coalesce((select sum(amount_minor) from public.royalty_manual r where r.partner_id = p_partner and r.month = m.m), 0)::bigint as manual,
      coalesce((select sum(amount_minor) from public.royalty_payment r where r.partner_id = p_partner and r.month = m.m), 0)::bigint as paid,
      m.m >= app_private.current_month() as open
    from months m left join rev on rev.m = m.m
  )
  select x.m, x.revenue, x.bp, round(x.revenue * x.bp / 10000.0)::bigint, x.manual, x.paid,
    case when x.open then x.manual - x.paid else round(x.revenue * x.bp / 10000.0)::bigint + x.manual - x.paid end,
    x.open
  from x order by x.m
$$;
