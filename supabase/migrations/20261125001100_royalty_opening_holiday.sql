-- An explicit date protects previously booked periods when old opening dates are unknown.
alter table public.partner add column royalty_holiday_from date check (isfinite(royalty_holiday_from));

create function public.royalty_holiday_start_set(p_partner uuid, p_started_on date, p_expected_start date) returns void
language plpgsql security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare saved date;
begin
  perform app_private.royalty_partner_check(p_partner);
  if p_started_on is not null and (not isfinite(p_started_on) or p_started_on > (now() at time zone 'Europe/Moscow')::date) then
    perform app_private.fail('validation', 'Укажите фактическую дату открытия', 'started_on');
  end if;
  select royalty_holiday_from into saved from public.partner where id = p_partner for update;
  if saved is not distinct from p_started_on then return; end if;
  if saved is distinct from p_expected_start then
    perform app_private.fail('version-conflict', 'Дата открытия уже изменена. Откройте настройки каникул заново');
  end if;
  update public.partner set royalty_holiday_from = p_started_on, updated_at = now() where id = p_partner;
  perform app_private.audit('royalty.holiday', 'partner', p_partner, p_partner,
    jsonb_build_object('before', saved, 'after', p_started_on));
end $$;
revoke execute on function public.royalty_holiday_start_set(uuid,date,date) from public, anon, service_role;
grant execute on function public.royalty_holiday_start_set(uuid,date,date) to authenticated;
insert into app_private.client_command(fn) values ('public.royalty_holiday_start_set(uuid,date,date)');

create function app_private.royalty_holiday_day(p_day date, p_start date) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(p_day >= p_start and p_day < (p_start + interval '2 months')::date, false)
$$;

revoke execute on function app_private.royalty_holiday_day(date,date)
  from public, anon, authenticated, service_role;
do $acl$
declare trusted name;
begin
  for trusted in select rolname from pg_roles where rolname in ('postgres','supabase_admin') loop
    execute format('grant execute on function app_private.royalty_holiday_day(date,date) to %I', trusted);
  end loop;
end $acl$;

create or replace function app_private.royalty_ledger(p_partner uuid)
returns table (month date, revenue_minor bigint, rate_bp int, accrued_minor bigint, manual_minor bigint, paid_minor bigint,
  debt_minor bigint, is_open boolean)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with start as (
    select royalty_from as f, royalty_holiday_from as holiday from public.partner where id = p_partner
  ), months as (
    select date_trunc('month', day)::date as m from public.daily_revenue, start
      where partner_id = p_partner and (start.f is null or day >= start.f)
    union select month from public.royalty_manual where partner_id = p_partner
    union select month from public.royalty_payment where partner_id = p_partner
  ), rev as (
    select date_trunc('month', day)::date as m, sum(total_minor)::bigint as v,
      sum(total_minor) filter (where not app_private.royalty_holiday_day(day, start.holiday)) as billable from public.daily_revenue, start
      where partner_id = p_partner and (start.f is null or day >= start.f) group by 1
  ), x as (
    select m.m, coalesce(rev.v, 0) as revenue, coalesce(rev.billable, 0) as billable, app_private.rate_bp(p_partner, m.m) as bp,
      coalesce((select sum(amount_minor) from public.royalty_manual r where r.partner_id = p_partner and r.month is not distinct from m.m), 0)::bigint as manual,
      coalesce((select sum(amount_minor) from public.royalty_payment r where r.partner_id = p_partner and r.month is not distinct from m.m), 0)::bigint as paid,
      coalesce(m.m >= app_private.current_month(), false) as open
    from months m left join rev on rev.m = m.m
  )
  select x.m, x.revenue, x.bp, round(x.billable * x.bp / 10000.0)::bigint, x.manual, x.paid,
    case when x.open then x.manual - x.paid else round(x.billable * x.bp / 10000.0)::bigint + x.manual - x.paid end,
    x.open
  from x order by x.m
$$;

create or replace function app_private.fin_month(p_partner uuid, p_locations uuid[], p_month date, p_include_common boolean)
returns jsonb
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  with rate as (
    select royalty_from, app_private.rate_bp(p_partner, p_month) bp,
      royalty_holiday_from as holiday
    from public.partner where id = p_partner
  ), r as (
    select coalesce(sum(total_minor), 0)::bigint t, coalesce(sum(cash_minor), 0)::bigint c, coalesce(sum(card_minor), 0)::bigint k,
      coalesce(sum(total_minor) filter (where app_private.royalty_holiday_day(day, rate.holiday)), 0) as waived
    from public.daily_revenue cross join rate where location_id = any(p_locations) and day >= p_month and day < (p_month + interval '1 month')::date
  ), w as (
    select coalesce(sum(earned_minor), 0)::bigint e, coalesce(sum(return_minor), 0)::bigint refunds,
      coalesce(sum(earned_minor) filter (where day < p_month + 15), 0)::bigint first_half,
      coalesce(sum(earned_minor) filter (where day >= p_month + 15), 0)::bigint second_half,
      (count(*) filter (where counts_as_exit))::int n from public.work_shift
    where location_id = any(p_locations) and status = 'closed' and day >= p_month and day < (p_month + interval '1 month')::date
  ), p as (
    select case when count(*) = cardinality(p_locations) then sum(amount_minor)::bigint end v
    from public.revenue_plan where location_id = any(p_locations) and month = p_month
  ), x as (
    select coalesce(sum(amount_minor), 0)::bigint v from app_private.expense_rows(p_partner, p_locations, p_month, p_include_common)
  ), q as (
    select bp, holiday, royalty_from,
      case when p_month < royalty_from then 0 else round((r.t - r.waived) * bp / 10000)::bigint end v,
      case when p_month < royalty_from then 0 else round(r.t::numeric * bp / 10000)::bigint
          - round((r.t - r.waived) * bp / 10000)::bigint end as waived
    from r, rate
  )
  select jsonb_build_object(
    'month', p_month, 'revenue_minor', r.t, 'cash_minor', r.c, 'card_minor', r.k, 'plan_minor', p.v,
    'pct', case when p.v > 0 then round(r.t * 100.0 / p.v, 1) end,
    'payroll_minor', w.e, 'payroll_halves', jsonb_build_array(w.first_half, w.second_half),
    'shifts', w.n, 'return_minor', w.refunds,
    'rate_bp', q.bp,
    'royalty_minor', q.v,
    'waived_royalty_minor', q.waived,
    'royalty_holiday_until', case when p_month < (q.holiday + interval '2 months')::date
      and (p_month + interval '1 month')::date > q.holiday then (q.holiday + interval '2 months')::date end,
    'royalty_accrual_from', case when p_month < (q.holiday + interval '2 months')::date
      and (p_month + interval '1 month')::date > q.holiday
      then greatest((q.holiday + interval '2 months')::date, q.royalty_from) end,
    'expenses_minor', x.v,
    'net_minor', r.t - w.refunds - w.e - q.v - x.v,
    'is_open', p_month >= app_private.current_month())
  from r, w, p, x, q
$$;

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
      round(coalesce(sum(d.amount) filter (where not app_private.royalty_holiday_day(d.day, p.royalty_holiday_from)), 0)
        * app_private.rate_bp(p.id, d.month) / 10000.0), null, null
    from daily d join public.partner p on p.id = d.partner_id and p.currency = d.currency
    where not p.is_demo and (p.royalty_from is null or d.month >= p.royalty_from)
    group by p.id, d.month
    union all
    select a.partner_id, null, a.month, null, p.currency,
      case when a.kind = 'past_debt' then 'royalty_past_debt' else 'royalty_adjustment' end,
      'royalty_adjustment:' || a.id, null, a.amount_minor, null, null
    from public.royalty_manual a join public.partner p on p.id = a.partner_id
    where a.month between p_from and p_through
      or (a.month is null and (a.created_at at time zone 'Europe/Moscow')::date between p_from and p_through)
    union all
    select x.partner_id, null, x.month, x.paid_on, p.currency,
      'royalty_payment', 'royalty_payment:' || x.id, case when x.paid_on is null then 'Оплата подтверждена без даты' end, x.amount_minor, null, null
    from public.royalty_payment x join public.partner p on p.id = x.partner_id
    where (x.paid_on <= p_through and (x.month >= p_from or x.paid_on >= p_from))
      or (x.paid_on is null and (x.created_at at time zone 'Europe/Moscow')::date <= p_through
          and (x.month >= p_from or (x.created_at at time zone 'Europe/Moscow')::date >= p_from))
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

create or replace function public.royalty_my() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid; v_partners uuid[]; p public.partner; v_cur date := app_private.current_month(); v_open record; v_elapsed int; v_days int; v_holiday date;
begin
  perform app_private.require_user();
  select array_agg(distinct scope_id) into v_partners
    from app_private.active_assignments() a where a.role = 'franchisee' and a.scope_id is not null;
  if v_partners is null then perform app_private.fail('forbidden', 'Роялти видит франчайзи'); end if;
  if cardinality(v_partners) > 1 then perform app_private.fail('validation', 'К аккаунту привязано несколько франчайзи. Обратитесь в управляющую компанию'); end if;
  v_partner := v_partners[1];
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  v_holiday := p.royalty_holiday_from;
  select * into v_open from app_private.royalty_ledger(v_partner) g where g.month = v_cur;
  v_days := extract(day from (v_cur + interval '1 month - 1 day'))::int;
  v_elapsed := greatest(1, extract(day from (now() at time zone 'Europe/Moscow'))::int - 1);
  return jsonb_build_object(
    'partner_id', p.id, 'partner_name', p.name, 'currency', p.currency,
    'rate_bp', app_private.rate_bp(p.id, v_cur),
    'debt_minor', (select coalesce(sum(debt_minor), 0) from app_private.royalty_ledger(v_partner) g where not g.is_open),
    'live', jsonb_build_object('month', v_cur,
      'revenue_minor', coalesce(v_open.revenue_minor, 0), 'accrued_minor', coalesce(v_open.accrued_minor, 0),
      -- прогноз на конец месяца по темпу прошедших дней
      'projected_accrual_minor', round(coalesce(v_open.accrued_minor, 0)::numeric / v_elapsed * v_days)::bigint,
      'paid_minor', coalesce(v_open.paid_minor, 0),
      'royalty_holiday_until', case when v_cur < (v_holiday + interval '2 months')::date
        and (v_cur + interval '1 month')::date > v_holiday then (v_holiday + interval '2 months')::date end,
      'royalty_accrual_from', case when v_cur < (v_holiday + interval '2 months')::date
        and (v_cur + interval '1 month')::date > v_holiday
        then greatest((v_holiday + interval '2 months')::date, p.royalty_from) end,
      'waived_royalty_minor', round(coalesce(v_open.revenue_minor, 0)::numeric * app_private.rate_bp(p.id, v_cur) / 10000)::bigint
        - coalesce(v_open.accrued_minor, 0)),
    'undated', (select to_jsonb(g) from app_private.royalty_ledger(v_partner) g where g.month is null),
    'months', coalesce((select jsonb_agg(to_jsonb(g) || app_private.royalty_manual_breakdown(v_partner, g.month) order by g.month desc) from app_private.royalty_ledger(v_partner) g where g.month is not null), '[]'::jsonb),
    'undated_payments', coalesce((select jsonb_agg(jsonb_build_object('month', r.month, 'amount_minor', r.amount_minor,
      'paid_on', r.paid_on, 'note', r.note) order by r.paid_on desc) from public.royalty_payment r
      where r.partner_id = v_partner and r.month is null), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('month', r.month, 'amount_minor', r.amount_minor, 'paid_on', r.paid_on, 'note', r.note)
      order by r.paid_on desc) from public.royalty_payment r where r.partner_id = v_partner and r.month is not null), '[]'::jsonb));
end $$;

create or replace function public.royalty_partner(p_partner uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare p public.partner;
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  select * into p from public.partner where id = p_partner;
  if not found then perform app_private.fail('not-found', 'Франчайзи не найден'); end if;
  return jsonb_build_object(
    'partner_id', p.id, 'partner_name', p.name, 'currency', p.currency,
    'rate_bp', app_private.rate_bp(p.id, app_private.current_month()),
    'royalty_holiday_from', p.royalty_holiday_from,
    'royalty_holiday_until', (p.royalty_holiday_from + interval '2 months')::date,
    'royalty_accrual_from', greatest((p.royalty_holiday_from + interval '2 months')::date, p.royalty_from),
    'undated', (select to_jsonb(g) from app_private.royalty_ledger(p.id) g where g.month is null),
    'months', coalesce((select jsonb_agg(to_jsonb(g) || app_private.royalty_manual_breakdown(p.id, g.month)
      || jsonb_build_object('waived_royalty_minor', round(g.revenue_minor::numeric * g.rate_bp / 10000)::bigint - g.accrued_minor)
      order by g.month desc) from app_private.royalty_ledger(p.id) g where g.month is not null), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'paid_on', r.paid_on,
        'note', r.note, 'created_at', r.created_at) order by r.paid_on desc, r.created_at desc)
      from public.royalty_payment r where r.partner_id = p.id), '[]'::jsonb),
    'manual', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note,
        'created_at', r.created_at) order by r.month desc)
      from public.royalty_manual r where r.partner_id = p.id), '[]'::jsonb),
    'rates', coalesce((select jsonb_agg(jsonb_build_object('effective_from', r.effective_from, 'rate_bp', r.rate_bp) order by r.effective_from desc)
      from public.royalty_rate r where r.partner_id = p.id), '[]'::jsonb));
end $$;
