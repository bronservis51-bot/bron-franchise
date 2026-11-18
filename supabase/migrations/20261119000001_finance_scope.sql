-- A single-location view excludes general expenses even if it covers the entire network of this partner.
create function app_private.expense_rows(p_partner uuid, p_locations uuid[], p_month date, p_include_common boolean)
returns setof public.expense
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select e.* from public.expense e
  where e.partner_id = p_partner and e.month = p_month
    and (e.location_id = any(p_locations) or (p_include_common and e.location_id is null))
$$;

create function app_private.fin_month(p_partner uuid, p_locations uuid[], p_month date, p_include_common boolean)
returns jsonb
language sql stable set search_path = pg_catalog, public, app_private, pg_temp as $$
  with r as (
    select coalesce(sum(total_minor), 0)::bigint t, coalesce(sum(cash_minor), 0)::bigint c, coalesce(sum(card_minor), 0)::bigint k
    from public.daily_revenue where location_id = any(p_locations) and day >= p_month and day < (p_month + interval '1 month')::date
  ), w as (
    select coalesce(sum(earned_minor), 0)::bigint e, count(*)::int n from public.work_shift
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
    'payroll_minor', w.e, 'shifts', w.n,
    'rate_bp', q.bp,
    'royalty_minor', q.v,
    'expenses_minor', x.v,
    'net_minor', r.t - w.e - q.v - x.v,
    'is_open', p_month >= app_private.current_month())
  from r, w, p, x, q
$$;

create or replace function public.finance_my(p_month date, p_location uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
declare v_partner uuid; p public.partner; v_month date := date_trunc('month', p_month)::date; v_locs uuid[]; v_all uuid[]; m date;
  v_months jsonb := '[]'::jsonb;
  v_include_common boolean := p_location is null;
begin
  perform app_private.require_user();
  select scope_id into v_partner from app_private.active_assignments() a where a.role = 'franchisee' limit 1;
  if v_partner is null then perform app_private.fail('forbidden', 'Финансы видит франчайзи'); end if;
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  select coalesce(array_agg(id order by name), '{}'::uuid[]) into v_all from public.location where partner_id = v_partner;
  if p_location is not null and not (p_location = any(v_all)) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_locs := case when v_include_common then v_all else array[p_location] end;
  for m in select generate_series(v_month - interval '5 months', v_month, interval '1 month')::date loop
    v_months := v_months || jsonb_build_array(app_private.fin_month(v_partner, v_locs, m, v_include_common));
  end loop;
  return jsonb_build_object(
    'partner_name', p.name, 'currency', p.currency, 'month', v_month, 'location_id', p_location,
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status) order by name)
      from public.location where partner_id = v_partner), '[]'::jsonb),
    'current', app_private.fin_month(v_partner, v_locs, v_month, v_include_common),
    'months', v_months,
    'by_location', case when v_include_common then coalesce((select jsonb_agg(app_private.fin_month(v_partner, array[l.id], v_month, false)
        || jsonb_build_object('location_id', l.id, 'location_name', l.name) order by l.name)
      from public.location l where l.partner_id = v_partner), '[]'::jsonb) end,
    'by_staff', coalesce((select jsonb_agg(jsonb_build_object('user_id', u.id, 'full_name', u.full_name, 'shifts', x.n, 'revenue_minor', x.t, 'earned_minor', x.e)
        order by x.e desc)
      from (select employee_id, count(*)::int n, sum(total_minor)::bigint t, sum(earned_minor)::bigint e from public.work_shift
            where location_id = any(v_locs) and status = 'closed' and day >= v_month and day < v_month + interval '1 month' group by employee_id) x
      join public.app_user u on u.id = x.employee_id), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'month', e.month, 'location_id', e.location_id, 'location_name', l.name,
        'category', e.category, 'amount_minor', e.amount_minor, 'note', e.note) order by e.category, l.name nulls first)
      from app_private.expense_rows(v_partner, v_locs, v_month, v_include_common) e left join public.location l on l.id = e.location_id), '[]'::jsonb),
    'expense_categories', coalesce((select jsonb_agg(c order by n desc, c) from (
        select category c, count(*) n from public.expense where partner_id = v_partner group by category) t), '[]'::jsonb),
    'prev_expenses_count', (select count(*) from public.expense where partner_id = v_partner and month = (v_month - interval '1 month')::date),
    'royalty', case when v_include_common then public.royalty_my() end);
end $$;

-- CREATE OR REPLACE retains the RPC's owner. On the native installation this
-- application role differs from the role that creates the new private helpers.
revoke execute on function app_private.fin_month(uuid, uuid[], date, boolean),
  app_private.expense_rows(uuid, uuid[], date, boolean) from public, anon, authenticated;

do $finance_acl$
declare
  caller name := (select pg_get_userbyid(proowner) from pg_proc
    where oid = 'public.finance_my(date,uuid)'::regprocedure);
begin
  if caller is null or caller not in ('postgres', 'supabase_admin') then
    raise exception 'Unexpected finance_my owner';
  end if;
  execute format('grant execute on function app_private.fin_month(uuid,uuid[],date,boolean),
    app_private.expense_rows(uuid,uuid[],date,boolean) to %I', caller);
end
$finance_acl$;

drop function app_private.fin_month(uuid, uuid[], date);
drop function app_private.expense_rows(uuid, uuid[], date);
