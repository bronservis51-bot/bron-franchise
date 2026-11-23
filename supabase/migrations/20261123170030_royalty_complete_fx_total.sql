-- Rule 5.2. Do not show a partial RUB balance when a nonzero amount has no conversion rate.
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
      'debt_months', coalesce(jsonb_agg(jsonb_build_object('month', g.month, 'debt_minor', g.debt_minor) order by g.month)
                      filter (where g.debt_minor > 0 and not g.is_open), '[]'::jsonb),
      'last_payment_on', (select max(paid_on) from public.royalty_payment r where r.partner_id = p.id),
      'fx_rub', app_private.fx_rub(p.currency, current_date)
    ) as row_data
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
