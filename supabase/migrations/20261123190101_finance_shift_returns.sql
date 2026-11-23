-- Subtract returns from the recorded balance while preserving gross sales and royalties.
create or replace function app_private.fin_month(p_partner uuid, p_locations uuid[], p_month date, p_include_common boolean)
returns jsonb
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  with r as (
    select coalesce(sum(total_minor), 0)::bigint t, coalesce(sum(cash_minor), 0)::bigint c, coalesce(sum(card_minor), 0)::bigint k
    from public.daily_revenue where location_id = any(p_locations) and day >= p_month and day < (p_month + interval '1 month')::date
  ), w as (
    select coalesce(sum(earned_minor), 0)::bigint e, coalesce(sum(return_minor), 0)::bigint refunds,
      (count(*) filter (where counts_as_exit))::int n from public.work_shift
    where location_id = any(p_locations) and status = 'closed' and day >= p_month and day < (p_month + interval '1 month')::date
  ), p as (
    select case when count(*) = cardinality(p_locations) then sum(amount_minor)::bigint end v
    from public.revenue_plan where location_id = any(p_locations) and month = p_month
  ), x as (
    select coalesce(sum(amount_minor), 0)::bigint v from app_private.expense_rows(p_partner, p_locations, p_month, p_include_common)
  ), rate as (
    select royalty_from, app_private.rate_bp(p_partner, p_month) bp from public.partner where id = p_partner
  ), q as (
    select bp, case when p_month < royalty_from then 0
      else round(r.t::numeric * bp / 10000)::bigint end v
    from r, rate
  )
  select jsonb_build_object(
    'month', p_month, 'revenue_minor', r.t, 'cash_minor', r.c, 'card_minor', r.k, 'plan_minor', p.v,
    'pct', case when p.v > 0 then round(r.t * 100.0 / p.v, 1) end,
    'payroll_minor', w.e, 'shifts', w.n, 'return_minor', w.refunds,
    'rate_bp', q.bp,
    'royalty_minor', q.v,
    'expenses_minor', x.v,
    'net_minor', r.t - w.refunds - w.e - q.v - x.v,
    'is_open', p_month >= app_private.current_month())
  from r, w, p, x, q
$$;

-- The existing export projection retains its signature and reporting grants.
create or replace function app_private.google_finance_rows(p_from date, p_through date)
returns table (
  partner_id uuid, partner text, point_id uuid, point text, month text, day text,
  currency text, minor_unit int, kind text, key text, category text, amount text, cash text, card text
)
language sql stable security definer
set search_path = pg_catalog, public, app_private, pg_temp as $$
  with daily as (
    select r.partner_id, r.location_id, date_trunc('month', r.day)::date as month, r.day,
      r.currency, 'revenue'::text as kind, 'revenue:' || r.location_id || ':' || r.day || ':' || r.currency as key,
      null::text as category, sum(r.total_minor) as amount,
      case when sum(r.unallocated_minor) < sum(r.total_minor) or sum(r.total_minor) = 0 then sum(r.cash_minor) end as cash,
      case when sum(r.unallocated_minor) < sum(r.total_minor) or sum(r.total_minor) = 0 then sum(r.card_minor) end as card
    from public.daily_revenue r
    join public.location l on l.id = r.location_id and l.partner_id = r.partner_id
    where r.day between p_from and p_through
    group by r.partner_id, r.location_id, r.day, r.currency
  ), source as (
    select * from daily
    union all
    select l.partner_id, d.location_id, date_trunc('month', d.day)::date, d.day, l.currency,
      'day_off', 'day_off:' || d.location_id || ':' || d.day, null, null, null, null
    from app_private.revenue_day_off d join public.location l on l.id = d.location_id
    where d.day between p_from and p_through
    union all
    select l.partner_id, x.location_id, x.month, null, l.currency,
      'plan', 'plan:' || x.location_id || ':' || x.month, null, x.amount_minor, null, null
    from public.revenue_plan x join public.location l on l.id = x.location_id
    where x.month between p_from and p_through
    union all
    select w.partner_id, w.location_id, date_trunc('month', w.day)::date, w.day, l.currency,
      'payroll', 'payroll:' || w.location_id || ':' || w.day, null, sum(w.earned_minor), null, null
    from public.work_shift w join public.location l on l.id = w.location_id
    where w.status = 'closed' and w.day between p_from and p_through
    group by w.partner_id, w.location_id, w.day, l.currency
    union all
    select w.partner_id, w.location_id, date_trunc('month', w.day)::date, w.day, l.currency,
      'return', 'return:' || w.location_id || ':' || w.day, null, sum(w.return_minor), null, null
    from public.work_shift w join public.location l on l.id = w.location_id
    where w.status = 'closed' and w.return_minor > 0 and w.day between p_from and p_through
    group by w.partner_id, w.location_id, w.day, l.currency
    union all
    select e.partner_id, e.location_id, e.month, null, p.currency,
      'expense', 'expense:' || e.id, e.category, e.amount_minor, null, null
    from public.expense e join public.partner p on p.id = e.partner_id
    where e.month between p_from and p_through
    union all
    select p.id, null, d.month, null, p.currency,
      'royalty', 'royalty:' || p.id || ':' || d.month, null,
      round(sum(d.amount) * app_private.rate_bp(p.id, d.month) / 10000.0), null, null
    from daily d join public.partner p on p.id = d.partner_id and p.currency = d.currency
    where not p.is_demo and (p.royalty_from is null or d.month >= p.royalty_from)
    group by p.id, d.month
    union all
    select a.partner_id, null, a.month, null, p.currency,
      case when a.kind = 'past_debt' then 'royalty_past_debt' else 'royalty_adjustment' end,
      'royalty_adjustment:' || a.id, null, a.amount_minor, null, null
    from public.royalty_manual a join public.partner p on p.id = a.partner_id
    where a.month between p_from and p_through
    union all
    select x.partner_id, null, x.month, x.paid_on, p.currency,
      'royalty_payment', 'royalty_payment:' || x.id, null, x.amount_minor, null, null
    from public.royalty_payment x join public.partner p on p.id = x.partner_id
    where x.paid_on <= p_through and (x.month >= p_from or x.paid_on >= p_from)
  )
  select s.partner_id, p.name, s.location_id, l.name, s.month::text, s.day::text, s.currency,
    c.minor_unit::int, s.kind, s.key, s.category, s.amount::text, s.cash::text, s.card::text
  from source s
  join public.partner p on p.id = s.partner_id and not p.is_demo
  left join public.location l on l.id = s.location_id and l.partner_id = s.partner_id
  join public.currency c on c.code = s.currency
  where p_from <= p_through and p_from = date_trunc('month', p_from)::date
    and (s.location_id is null or l.id is not null)
  order by s.month desc, p.name, s.partner_id, s.currency, s.day, s.key
$$;

create or replace function public.team_revenue_month(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare
  month_start date := date_trunc('month', p_month)::date;
  month_end date := (month_start + interval '1 month')::date;
  is_team_manager boolean;
begin
  perform app_private.require_user();
  select exists(select 1 from app_private.active_assignments() a
    where a.role = 'franchisee_manager' and a.scope_type = 'partner' and a.scope_id = p_partner) into is_team_manager;
  if not is_team_manager then perform app_private.require_perm('staff.manage', p_partner); end if;
  if p_month is null then perform app_private.fail('validation', 'Выберите месяц'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'location_id', l.id, 'location_name', l.name, 'currency', l.currency, 'total_minor', totals.sales,
      'missing_days', case when p.status = 'active' and l.status = 'active'
        then app_private.location_month(l, month_start)->'missing_days' else '[]'::jsonb end,
      'days', totals.days
    ) order by l.name)
    from public.location l
    join public.partner p on p.id = l.partner_id
    cross join lateral (
      select coalesce(sum(d.sales), 0) as sales, coalesce(jsonb_agg(jsonb_build_object(
        'day', d.day, 'total_minor', d.sales,
        'return_minor', (select coalesce(sum(w.return_minor), 0) from public.work_shift w
          where w.location_id = l.id and w.day = d.day and w.status = 'closed')
      ) order by d.day desc), '[]'::jsonb) as days
      from (select r.day, sum(r.total_minor) as sales from public.daily_revenue r
        where r.location_id = l.id and r.day >= month_start and r.day < month_end group by r.day) d
    ) totals
    where l.partner_id = p_partner and (app_private.staff_owner(p_partner) or (is_team_manager and exists (
      select 1 from public.staff_member s where s.user_id = auth.uid() and s.partner_id = p_partner
        and s.active and l.id = any(s.location_ids))))), '[]'::jsonb);
end $$;
