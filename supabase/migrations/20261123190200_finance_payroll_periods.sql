-- Split closed-shift accrual on the 16th within each existing monthly scope.
-- Both halves use the booked amount, including additional locations without another daily guarantee.
create or replace function app_private.fin_month(p_partner uuid, p_locations uuid[], p_month date, p_include_common boolean)
returns jsonb
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  with r as (
    select coalesce(sum(total_minor), 0)::bigint t, coalesce(sum(cash_minor), 0)::bigint c, coalesce(sum(card_minor), 0)::bigint k
    from public.daily_revenue where location_id = any(p_locations) and day >= p_month and day < (p_month + interval '1 month')::date
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
    'payroll_minor', w.e, 'payroll_halves', jsonb_build_array(w.first_half, w.second_half),
    'shifts', w.n, 'return_minor', w.refunds,
    'rate_bp', q.bp,
    'royalty_minor', q.v,
    'expenses_minor', x.v,
    'net_minor', r.t - w.refunds - w.e - q.v - x.v,
    'is_open', p_month >= app_private.current_month())
  from r, w, p, x, q
$$;

create or replace function public.finance_my(p_month date, p_location uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_partner uuid; v_partners uuid[]; p public.partner; v_month date := date_trunc('month', p_month)::date; v_locs uuid[]; v_all uuid[]; m date;
  v_months jsonb := '[]'::jsonb;
  v_include_common boolean := p_location is null;
begin
  perform app_private.require_user();
  select array_agg(distinct scope_id) into v_partners
    from app_private.active_assignments() a where a.role = 'franchisee' and a.scope_id is not null;
  if v_partners is null then perform app_private.fail('forbidden', 'Финансы видит франчайзи'); end if;
  if cardinality(v_partners) > 1 then perform app_private.fail('validation', 'К аккаунту привязано несколько франчайзи. Обратитесь в управляющую компанию'); end if;
  v_partner := v_partners[1];
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  select coalesce(array_agg(id order by name), '{}'::uuid[]) into v_all from public.location where partner_id = v_partner;
  if p_location is not null and not (p_location = any(v_all)) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_locs := case when v_include_common then v_all else array[p_location] end;
  for m in select generate_series(v_month - interval '5 months', v_month, interval '1 month')::date loop
    v_months := v_months || jsonb_build_array(app_private.fin_month(v_partner, v_locs, m, v_include_common));
  end loop;
  return jsonb_build_object(
    'partner_name', p.name, 'partner_status', p.status, 'currency', p.currency, 'month', v_month, 'location_id', p_location,
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status) order by name)
      from public.location where partner_id = v_partner), '[]'::jsonb),
    'current', app_private.fin_month(v_partner, v_locs, v_month, v_include_common),
    'months', v_months,
    'by_location', case when v_include_common then coalesce((select jsonb_agg(app_private.fin_month(v_partner, array[l.id], v_month, false)
        || jsonb_build_object('location_id', l.id, 'location_name', l.name) order by l.name)
      from public.location l where l.partner_id = v_partner), '[]'::jsonb) end,
    'by_staff', coalesce((select jsonb_agg(jsonb_build_object('user_id', u.id, 'full_name', u.full_name,
        'shifts', x.n, 'revenue_minor', x.t, 'earned_minor', x.e,
        'payroll_halves', jsonb_build_array(x.first_half, x.second_half)) order by x.e desc)
      from (select employee_id, (count(*) filter (where counts_as_exit))::int n,
            sum(total_minor)::bigint t, sum(earned_minor)::bigint e,
            coalesce(sum(earned_minor) filter (where day < v_month + 15), 0)::bigint first_half,
            coalesce(sum(earned_minor) filter (where day >= v_month + 15), 0)::bigint second_half
          from public.work_shift
          where location_id = any(v_locs) and status = 'closed' and day >= v_month and day < v_month + interval '1 month'
          group by employee_id) x
      join public.app_user u on u.id = x.employee_id), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'month', e.month, 'location_id', e.location_id, 'location_name', l.name,
        'category', e.category, 'amount_minor', e.amount_minor, 'note', e.note, 'recurring', e.recurring) order by e.category, l.name nulls first)
      from app_private.expense_rows(v_partner, v_locs, v_month, v_include_common) e left join public.location l on l.id = e.location_id), '[]'::jsonb),
    'expense_categories', coalesce((select jsonb_agg(c order by n desc, c) from (
        select category c, count(*) n from public.expense where partner_id = v_partner group by category) t), '[]'::jsonb),
    'prev_expenses_count', (select count(*) from public.expense where partner_id = v_partner and recurring and month = (v_month - interval '1 month')::date),
    'royalty', case when v_include_common then public.royalty_my() end);
end $$;

create or replace function public.manager_economy(p_month date) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare v_month date := date_trunc('month',p_month)::date;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return jsonb_build_object(
    'month',v_month,
    'company_expenses',coalesce((select jsonb_agg(jsonb_build_object(
      'id',e.id,'category',e.category,'amount_minor',e.amount_minor,'note',e.note,'created_at',e.created_at
    ) order by e.category,e.created_at,e.id) from app_private.network_expense e where e.month=v_month),'[]'::jsonb),
    'company_expense_totals',coalesce((select jsonb_agg(jsonb_build_object('category',x.category,'amount_minor',x.amount_minor)
      order by x.category) from (select category,sum(amount_minor)::bigint amount_minor
        from app_private.network_expense where month=v_month group by category) x),'[]'::jsonb),
    'partners',coalesce((select jsonb_agg(jsonb_build_object(
      'partner_id',p.id,'partner_name',p.name,'currency',p.currency,
      'payroll_minor',coalesce(w.payroll_minor,0),
      'payroll_halves',jsonb_build_array(coalesce(w.first_half,0),coalesce(w.second_half,0)),
      'closed_shifts',coalesce(w.closed_shifts,0),
      'expenses_minor',coalesce(x.expenses_minor,0),
      'expense_categories',coalesce(x.categories,'[]'::jsonb)
    ) order by p.name) from public.partner p
      left join lateral (
        select sum(s.earned_minor)::bigint payroll_minor, count(*)::int closed_shifts,
          sum(s.earned_minor) filter (where s.day < v_month + 15)::bigint first_half,
          sum(s.earned_minor) filter (where s.day >= v_month + 15)::bigint second_half
        from public.work_shift s where s.partner_id=p.id and s.status='closed'
          and s.day>=v_month and s.day<(v_month+interval '1 month')::date
      ) w on true
      left join lateral (
        select sum(e.category_total)::bigint expenses_minor,
          jsonb_agg(jsonb_build_object('category',e.category,'amount_minor',e.category_total) order by e.category) categories
        from (select category,sum(amount_minor)::bigint category_total
          from public.expense where partner_id=p.id and month=v_month group by category) e
      ) x on true where p.status='active'),'[]'::jsonb)
  );
end $$;
