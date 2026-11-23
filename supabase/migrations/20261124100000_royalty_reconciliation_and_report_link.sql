-- Keep verified settlements without a bank date and prior debt without a known accounting period.
alter table public.royalty_payment alter column paid_on drop not null;
alter table public.royalty_payment alter column month drop not null;
alter table public.royalty_payment add constraint royalty_payment_has_period_or_date
  check (month is not null or paid_on is not null);
alter table public.royalty_manual alter column month drop not null;
alter table public.royalty_manual add constraint royalty_correction_has_period
  check (month is not null or kind = 'past_debt');

create table app_private.manager_google_report_settings (
  singleton boolean primary key default true check (singleton),
  spreadsheet_id text not null check (spreadsheet_id ~ '^[A-Za-z0-9_-]{20,100}$')
);
alter table app_private.manager_google_report_settings enable row level security;

create function public.manager_google_report_link()
returns text language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return (select 'https://docs.google.com/spreadsheets/d/' || spreadsheet_id || '/edit'
    from app_private.manager_google_report_settings where singleton);
end $$;

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
      coalesce((select sum(amount_minor) from public.royalty_manual r where r.partner_id = p_partner and r.month is not distinct from m.m), 0)::bigint as manual,
      coalesce((select sum(amount_minor) from public.royalty_payment r where r.partner_id = p_partner and r.month is not distinct from m.m), 0)::bigint as paid,
      coalesce(m.m >= app_private.current_month(), false) as open
    from months m left join rev on rev.m = m.m
  )
  select x.m, x.revenue, x.bp, round(x.revenue * x.bp / 10000.0)::bigint, x.manual, x.paid,
    case when x.open then x.manual - x.paid else round(x.revenue * x.bp / 10000.0)::bigint + x.manual - x.paid end,
    x.open
  from x order by x.m
$$;

create or replace function app_private.royalty_manual_breakdown(p_partner uuid, p_month date, p_before date default null)
returns jsonb language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object(
    'correction_minor', coalesce(sum(r.amount_minor) filter (where r.kind = 'correction'), 0),
    'past_debt_minor', coalesce(sum(r.amount_minor) filter (where r.kind = 'past_debt'), 0))
  from public.royalty_manual r
  where r.partner_id = p_partner and (r.month = p_month or (p_month is null and p_before is not null and (r.month < p_before or r.month is null)))
$$;

create or replace function public.royalty_summary(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', p_month)::date; v_rows jsonb; v_cur date := app_private.current_month();
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  select coalesce(jsonb_agg(row_data order by row_data ->> 'partner_name'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
      'partner_id', p.id, 'partner_name', p.name, 'status', p.status, 'country', p.country, 'currency', p.currency,
      'rate_bp', app_private.rate_bp(p.id, coalesce(v_month, v_cur)),
      'revenue_minor', coalesce(sum(g.revenue_minor) filter (where (v_month is null and not g.is_open) or g.month = v_month), 0),
      'accrued_minor', coalesce(sum(g.accrued_minor) filter (where (v_month is null and not g.is_open) or g.month = v_month), 0),
      'manual_minor', coalesce(sum(g.manual_minor) filter (where (v_month is null and not g.is_open) or g.month = v_month), 0),
      'paid_minor', coalesce(sum(g.paid_minor) filter (where (v_month is null and not g.is_open) or g.month = v_month), 0),
      'debt_minor', coalesce(sum(case when v_month is null and not g.is_open then g.debt_minor
                                       when g.month = v_month then g.accrued_minor + g.manual_minor - g.paid_minor end), 0),
      'is_open', v_month is not null and v_month >= v_cur,
      'current_revenue_minor', coalesce(sum(g.revenue_minor) filter (where g.month = v_cur), 0),
      'current_accrual_minor', coalesce(sum(g.accrued_minor) filter (where g.month = v_cur), 0),
      'undated_debt_minor', coalesce(sum(g.debt_minor) filter (where v_month is null and g.month is null), 0),
      'debt_months', coalesce(jsonb_agg(jsonb_build_object('month', g.month, 'debt_minor', g.debt_minor) order by g.month)
                      filter (where g.debt_minor > 0 and not g.is_open and g.month is not null), '[]'::jsonb),
      'last_payment_on', (select max(paid_on) from public.royalty_payment r where r.partner_id = p.id),
      'fx_rub', app_private.fx_rub(p.currency, current_date)
    ) || app_private.royalty_manual_breakdown(p.id, v_month, v_cur) as row_data
    from public.partner p
    left join lateral app_private.royalty_ledger(p.id) g on true
    group by p.id
  ) t;
  return jsonb_build_object(
    'month', v_month, 'current_month', v_cur, 'rows', v_rows,
    'totals', (select coalesce(jsonb_agg(jsonb_build_object('currency', c, 'accrued_minor', a, 'paid_minor', pd, 'debt_minor', d) order by c), '[]'::jsonb)
      from (select x ->> 'currency' c, sum((x ->> 'accrued_minor')::bigint + (x ->> 'manual_minor')::bigint) a, sum((x ->> 'paid_minor')::bigint) pd,
                   sum((x ->> 'debt_minor')::bigint) d
            from jsonb_array_elements(v_rows) x group by 1) s),
    'debt_rub_minor', (select case
      when bool_or((x ->> 'debt_minor')::numeric <> 0 and (x ->> 'fx_rub') is null) then null
      else round(sum(case when (x ->> 'debt_minor')::numeric = 0 then 0
        else (x ->> 'debt_minor')::numeric * (x ->> 'fx_rub')::numeric end))
      end from jsonb_array_elements(v_rows) x));
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
    'undated', (select to_jsonb(g) from app_private.royalty_ledger(p.id) g where g.month is null),
    'months', coalesce((select jsonb_agg(to_jsonb(g) || app_private.royalty_manual_breakdown(p.id, g.month) order by g.month desc) from app_private.royalty_ledger(p.id) g where g.month is not null), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'paid_on', r.paid_on,
        'note', r.note, 'created_at', r.created_at) order by r.paid_on desc, r.created_at desc)
      from public.royalty_payment r where r.partner_id = p.id), '[]'::jsonb),
    'manual', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note,
        'created_at', r.created_at) order by r.month desc)
      from public.royalty_manual r where r.partner_id = p.id), '[]'::jsonb),
    'rates', coalesce((select jsonb_agg(jsonb_build_object('effective_from', r.effective_from, 'rate_bp', r.rate_bp) order by r.effective_from desc)
      from public.royalty_rate r where r.partner_id = p.id), '[]'::jsonb));
end $$;

create or replace function public.royalty_my() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid; v_partners uuid[]; p public.partner; v_cur date := app_private.current_month(); v_open record; v_elapsed int; v_days int;
begin
  perform app_private.require_user();
  select array_agg(distinct scope_id) into v_partners
    from app_private.active_assignments() a where a.role = 'franchisee' and a.scope_id is not null;
  if v_partners is null then perform app_private.fail('forbidden', 'Роялти видит франчайзи'); end if;
  if cardinality(v_partners) > 1 then perform app_private.fail('validation', 'К аккаунту привязано несколько франчайзи. Обратитесь в управляющую компанию'); end if;
  v_partner := v_partners[1];
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
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
      'paid_minor', coalesce(v_open.paid_minor, 0)),
    'undated', (select to_jsonb(g) from app_private.royalty_ledger(v_partner) g where g.month is null),
    'months', coalesce((select jsonb_agg(to_jsonb(g) || app_private.royalty_manual_breakdown(v_partner, g.month) order by g.month desc) from app_private.royalty_ledger(v_partner) g where g.month is not null), '[]'::jsonb),
    'undated_payments', coalesce((select jsonb_agg(jsonb_build_object('month', r.month, 'amount_minor', r.amount_minor,
      'paid_on', r.paid_on, 'note', r.note) order by r.paid_on desc) from public.royalty_payment r
      where r.partner_id = v_partner and r.month is null), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('month', r.month, 'amount_minor', r.amount_minor, 'paid_on', r.paid_on, 'note', r.note)
      order by r.paid_on desc) from public.royalty_payment r where r.partner_id = v_partner and r.month is not null), '[]'::jsonb));
end $$;

create or replace function public.royalty_ops(p_partner uuid default null, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  return coalesce((select jsonb_agg(t.x order by t.created_at desc) from (
    select * from (
      select r.created_at, jsonb_build_object('id', r.id, 'op', 'payment', 'partner_id', r.partner_id, 'partner_name', p.name, 'currency', p.currency,
        'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note, 'paid_on', r.paid_on, 'created_at', r.created_at,
        'by', (select full_name from public.app_user where id = r.created_by)) as x
      from public.royalty_payment r join public.partner p on p.id = r.partner_id where r.month is not null and (p_partner is null or r.partner_id = p_partner)
      union all
      select r.created_at, jsonb_build_object('id', r.id, 'op', r.kind, 'partner_id', r.partner_id, 'partner_name', p.name, 'currency', p.currency,
        'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note, 'created_at', r.created_at,
        'by', (select full_name from public.app_user where id = r.created_by))
      from public.royalty_manual r join public.partner p on p.id = r.partner_id where r.month is not null and (p_partner is null or r.partner_id = p_partner)
    ) u order by created_at desc limit greatest(1, least(p_limit, 200))) t), '[]'::jsonb);
end $$;

create or replace function public.royalty_ops_v2(p_partner uuid default null, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  return coalesce((select jsonb_agg(t.x order by t.created_at desc) from (
    select * from (
      select r.created_at, jsonb_build_object('id', r.id, 'op', 'payment', 'partner_id', r.partner_id, 'partner_name', p.name, 'currency', p.currency,
        'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note, 'paid_on', r.paid_on, 'created_at', r.created_at,
        'by', (select full_name from public.app_user where id = r.created_by)) as x
      from public.royalty_payment r join public.partner p on p.id = r.partner_id where p_partner is null or r.partner_id = p_partner
      union all
      select r.created_at, jsonb_build_object('id', r.id, 'op', r.kind, 'partner_id', r.partner_id, 'partner_name', p.name, 'currency', p.currency,
        'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note, 'created_at', r.created_at,
        'by', (select full_name from public.app_user where id = r.created_by))
      from public.royalty_manual r join public.partner p on p.id = r.partner_id where p_partner is null or r.partner_id = p_partner
    ) u order by created_at desc limit greatest(1, least(p_limit, 200))) t), '[]'::jsonb);
end $$;

create or replace function app_private.royalty_payment_reviewed(
  p_partner uuid, p_month date, p_amount bigint, p_paid_on date, p_note text, p_reviewed jsonb
) returns jsonb language plpgsql set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_matches jsonb; v_ids jsonb; v_id uuid;
begin
  perform app_private.royalty_partner_check(p_partner);
  if coalesce(p_amount, 0) <= 0 then perform app_private.fail('validation', 'Укажите сумму оплаты', 'amount'); end if;
  if (p_month is null and not exists (select 1 from public.royalty_manual where partner_id = p_partner and month is null))
      or (p_month is not null and not isfinite(p_month)) then
    perform app_private.fail('validation', 'Укажите месяц, за который оплата', 'month');
  end if;
  if p_paid_on is null or not isfinite(p_paid_on) or p_paid_on > current_date + 1 then
    perform app_private.fail('validation', 'Неверная дата оплаты', 'paid_on');
  end if;
  if p_reviewed is not null and jsonb_typeof(p_reviewed) <> 'array' then
    perform app_private.fail('validation', 'Проверьте похожие оплаты');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'royalty.payment:' || p_partner::text || ':' || (p_paid_on - date '2000-01-01')::text || ':' || p_amount::text, 0));

  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'month', r.month, 'note', r.note) order by r.month, r.id), '[]'::jsonb),
    coalesce(jsonb_agg(r.id), '[]'::jsonb) into v_matches, v_ids
  from public.royalty_payment r
  where r.partner_id = p_partner and r.paid_on = p_paid_on and r.amount_minor = p_amount;

  if v_ids <> '[]'::jsonb and not coalesce(v_ids @> p_reviewed and v_ids <@ p_reviewed, false) then
    return jsonb_build_object('matches', v_matches);
  end if;
  insert into public.royalty_payment(partner_id, month, amount_minor, paid_on, note, created_by)
  values (p_partner, date_trunc('month', p_month)::date, p_amount, p_paid_on, nullif(trim(p_note), ''), auth.uid()) returning id into v_id;
  perform app_private.audit('royalty.payment', 'royalty_payment', v_id, p_partner,
    jsonb_build_object('month', p_month, 'amount', p_amount, 'reviewed', v_ids));
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.royalty_manual_add(p_partner uuid, p_month date, p_amount bigint, p_note text default null) returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid;
begin
  perform app_private.royalty_partner_check(p_partner);
  if coalesce(p_amount, 0) <= 0 then perform app_private.fail('validation', 'Укажите сумму долга', 'amount'); end if;
  if p_month is null and nullif(btrim(p_note), '') is null then
    perform app_private.fail('validation', 'Укажите причину отсутствия периода', 'note');
  end if;
  if p_month is not null and (not isfinite(p_month) or date_trunc('month', p_month)::date > app_private.current_month()) then
    perform app_private.fail('validation', 'Укажите прошедший месяц', 'month');
  end if;
  insert into public.royalty_manual(partner_id, month, amount_minor, note, created_by)
  values (p_partner, date_trunc('month', p_month)::date, p_amount, nullif(trim(p_note), ''), auth.uid()) returning id into v_id;
  perform app_private.audit('royalty.manual', 'royalty_manual', v_id, p_partner, jsonb_build_object('month', p_month, 'amount', p_amount));
  return v_id;
end $$;

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

revoke all on function public.manager_google_report_link(), public.royalty_ops_v2(uuid,int) from public, anon;
grant execute on function public.manager_google_report_link(), public.royalty_ops_v2(uuid,int) to authenticated;
insert into app_private.client_command(fn) values ('public.manager_google_report_link()'), ('public.royalty_ops_v2(uuid,int)');
